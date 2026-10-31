import { listenEngineEvents, type EngineEventPayload } from "@/lib/events";
import { pluginBus } from "./events";

/**
 * 插件发起的「聊天会话轮次」宿主实现（SDK 0.3.18，权限 host:session）。
 *
 * 与 `ctx.agent.start`（插件自有后台轮次，事件只回插件）的分工：
 * 这里把轮次交给宿主聊天管线跑——会话立刻进侧栏（带运行中状态）、打开就是
 * 实时流式输出、聊天里的停止按钮照常可用，插件的模型/强度/渠道选择通过
 * per-tab 覆盖传递（不改用户的全局默认）。
 *
 * 回执：轮次终止时把 `{ runId, sessionId, engine, workspacePath, kind, error }`
 * emit 到 `plugin-run://<pluginId>` 总线话题，插件据此收尾自己的任务表。
 *
 * 独立成模块而不是内联进 context.ts：会话管线依赖链重（chat store / 引擎
 * 事件流），runtime/context 的单测只 mock 本模块（workspace-bridge 同款理由）。
 */

export interface PluginChatRunDef {
  engine: string;
  prompt: string;
  workspacePath: string;
  model?: string | null;
  effort?: string | null;
  providerId?: string | null;
}

export interface PluginChatRunHandle {
  runId: string;
  sessionId: string | null;
}

interface RunRecord {
  pluginId: string;
  engine: string;
  workspacePath: string;
  sessionId: string | null;
}

interface QueuedSessionMessage {
  pluginId: string;
  def: PluginSessionMessageDef;
  resolve: (handle: PluginSessionMessageHandle) => void;
  reject: (error: unknown) => void;
}

export interface PluginSessionMessageDef {
  engine: string;
  sessionId: string;
  workspacePath: string;
  prompt: string;
  ifBusy?: "queue" | "reject";
}

export interface PluginSessionMessageHandle {
  runId: string;
  sessionId: string;
}

/** runId → 属主插件与工作区；只在轮次存活期间有记录。 */
const runs = new Map<string, RunRecord>();
const queuedMessages = new Map<string, QueuedSessionMessage[]>();
const drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionKey(engine: string, sessionId: string): string {
  return `${engine}/${sessionId}`;
}

function isSessionBusy(store: { streamingByKey?: Record<string, true>; bySession?: Record<string, { streaming?: boolean }> }, key: string): boolean {
  return Boolean(store.streamingByKey?.[key] || store.bySession?.[key]?.streaming);
}

function emitRun(pluginId: string, payload: Record<string, unknown>): void {
  pluginBus.emit(`plugin-run://${pluginId}`, payload);
}

/** 终止事件里的原因文本（data 形状由引擎定义，逐种兜底）。 */
function errorTextOf(event: EngineEventPayload): string | null {
  const data = event.data as unknown;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object") {
    for (const key of ["message", "error", "text"] as const) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
}

let bridged = false;

/** 一次绑定的引擎事件旁路：只转发属于插件轮次的终态。 */
function ensureRunBridge(): void {
  if (bridged) return;
  bridged = true;
  void listenEngineEvents((events) => {
    for (const event of events) {
      const record = runs.get(event.runId);
      if (!record) {
        if ((event.kind === "done" || event.kind === "error") && event.sessionId) {
          scheduleQueueDrain(sessionKey(event.engine, event.sessionId));
        }
        continue;
      }
      // 原生 session id 常常不在 spawn 返回里，而是随首个事件 announce。
      // 一学到就转给插件：它的「打开会话」按钮依赖这个 id。
      if (event.sessionId && !record.sessionId) {
        record.sessionId = event.sessionId;
        pluginBus.emit(`plugin-run://${record.pluginId}`, {
          runId: event.runId,
          sessionId: event.sessionId,
          engine: record.engine,
          workspacePath: record.workspacePath,
          kind: "session",
          error: null,
        });
      }
      if (event.kind !== "done" && event.kind !== "error") continue;
      runs.delete(event.runId);
      emitRun(record.pluginId, {
        runId: event.runId,
        sessionId: event.sessionId ?? record.sessionId,
        engine: record.engine,
        workspacePath: record.workspacePath,
        kind: event.kind,
        error: event.kind === "error" ? errorTextOf(event) : null,
      });
      scheduleQueueDrain(sessionKey(record.engine, event.sessionId ?? record.sessionId ?? ""));
    }
  });
}

function scheduleQueueDrain(key: string): void {
  if (!key || drainTimers.has(key)) return;
  const timer = setTimeout(() => {
    drainTimers.delete(key);
    void drainSessionQueue(key);
  }, 0);
  drainTimers.set(key, timer);
}

async function drainSessionQueue(key: string): Promise<void> {
  const queue = queuedMessages.get(key);
  if (!queue?.length) return;
  const chat = await import("@/features/chat/store");
  const store = chat.useChatStore.getState();
  if (isSessionBusy(store, key)) {
    scheduleQueueDrain(key);
    return;
  }
  const item = queue.shift()!;
  if (!queue.length) queuedMessages.delete(key);
  try {
    const handle = await launchPluginSessionMessage(item.pluginId, item.def);
    item.resolve(handle);
  } catch (error) {
    item.reject(error);
    // A failed queued turn must not strand later messages. The next item is
    // attempted once; a plugin may decide whether to enqueue it again.
    scheduleQueueDrain(key);
  }
}

async function launchPluginSessionMessage(
  pluginId: string,
  def: PluginSessionMessageDef,
): Promise<PluginSessionMessageHandle> {
  ensureRunBridge();
  const chat = await import("@/features/chat/store");
  const target = {
    engine: def.engine,
    sessionId: def.sessionId,
    workspacePath: def.workspacePath,
  };
  let handle: PluginSessionMessageHandle | null = null;
  try {
    await chat.useChatStore.getState().send(
      def.prompt,
      [],
      {
        onStarted: (info) => {
          if (!info.sessionId || info.sessionId !== def.sessionId) {
            throw new Error(`${pluginId}: host changed the target session while sending`);
          }
          handle = { runId: info.runId, sessionId: info.sessionId };
          runs.set(info.runId, {
            pluginId,
            engine: def.engine,
            workspacePath: def.workspacePath,
            sessionId: info.sessionId,
          });
          emitRun(pluginId, {
            runId: info.runId,
            sessionId: info.sessionId,
            engine: def.engine,
            workspacePath: def.workspacePath,
            kind: "started",
            error: null,
          });
        },
      },
      target,
    );
  } catch (error) {
    const started = handle as PluginSessionMessageHandle | null;
    if (started) {
      runs.delete(started.runId);
      emitRun(pluginId, {
        runId: started.runId,
        sessionId: started.sessionId,
        engine: def.engine,
        workspacePath: def.workspacePath,
        kind: "error",
        error: errorTextOf({ data: error } as EngineEventPayload) ?? String(error),
      });
    }
    throw error;
  }
  if (!handle) throw new Error(`${pluginId}: host did not report the existing session run identity`);
  return handle;
}

/** Send exactly one message to an already indexed session. The queue is held
 * here rather than in a plugin so every plugin shares the same per-session
 * serialization gate. */
export async function sendPluginSessionMessage(
  pluginId: string,
  raw: PluginSessionMessageDef,
): Promise<PluginSessionMessageHandle> {
  const engine = raw.engine?.trim();
  const sessionId = raw.sessionId?.trim();
  const workspacePath = raw.workspacePath?.trim();
  const prompt = raw.prompt?.trim();
  if (!engine || !sessionId || !workspacePath || !prompt) {
    throw new Error(`invalid_args: ${pluginId} sessions.sendMessage requires engine, sessionId, workspacePath and prompt`);
  }
  if (raw.ifBusy !== undefined && raw.ifBusy !== "queue" && raw.ifBusy !== "reject") {
    throw new Error(`invalid_args: ${pluginId} sessions.sendMessage ifBusy must be queue or reject`);
  }
  const def = { engine, sessionId, workspacePath, prompt, ifBusy: raw.ifBusy ?? "reject" };
  const chat = await import("@/features/chat/store");
  const store = chat.useChatStore.getState();
  const known = store.sessions.some(
    (session) =>
      session.engine === engine &&
      session.sessionId === sessionId &&
      session.workspacePath === workspacePath,
  );
  if (!known) {
    throw new Error(`${pluginId}: sessions.sendMessage unknown session ${engine}/${sessionId} in workspace ${workspacePath}`);
  }
  const key = sessionKey(engine, sessionId);
  if (isSessionBusy(store, key)) {
    if (def.ifBusy === "reject") {
      throw new Error(`${pluginId}: sessions.sendMessage busy ${engine}/${sessionId}`);
    }
    return await new Promise<PluginSessionMessageHandle>((resolve, reject) => {
      const queue = queuedMessages.get(key) ?? [];
      queue.push({ pluginId, def, resolve, reject });
      queuedMessages.set(key, queue);
    });
  }
  return launchPluginSessionMessage(pluginId, def);
}

/** Loader teardown hook: no queued callback may survive a hot reload, and an
 * active run is cancelled through the normal chat stop path. */
export function cancelPluginSessionRuns(pluginId: string): void {
  for (const [key, queue] of queuedMessages) {
    const keep: QueuedSessionMessage[] = [];
    for (const item of queue) {
      if (item.pluginId === pluginId) {
        item.reject(new Error(`${pluginId}: sessions.sendMessage cancelled during unload`));
      } else keep.push(item);
    }
    if (keep.length) queuedMessages.set(key, keep);
    else queuedMessages.delete(key);
  }
  for (const [runId, record] of runs) {
    if (record.pluginId !== pluginId) continue;
    runs.delete(runId);
    emitRun(pluginId, {
      runId,
      sessionId: record.sessionId,
      engine: record.engine,
      workspacePath: record.workspacePath,
      kind: "cancelled",
      error: "plugin unloaded",
    });
    void import("@/features/chat/store").then((chat) =>
      chat.useChatStore.getState().interrupt({
        engine: record.engine,
        sessionId: record.sessionId,
        workspacePath: record.workspacePath,
      }),
    ).catch(() => {});
  }
}

export async function startPluginChatRun(
  pluginId: string,
  def: PluginChatRunDef,
): Promise<PluginChatRunHandle> {
  const engine = def.engine?.trim();
  const prompt = def.prompt?.trim();
  const workspacePath = def.workspacePath?.trim();
  if (!engine) throw new Error(`invalid_args: ${pluginId} sessions.startRun: empty engine`);
  if (!prompt) throw new Error(`invalid_args: ${pluginId} sessions.startRun: empty prompt`);
  if (!workspacePath) {
    throw new Error(`invalid_args: ${pluginId} sessions.startRun: empty workspacePath`);
  }
  ensureRunBridge();

  // 动态引入：chat store 依赖链重，且本模块被 context.ts 静态引用。
  const chat = await import("@/features/chat/store");
  const store = chat.useChatStore.getState();
  const target = {
    engine,
    sessionId: null,
    workspacePath,
    ...(def.model ? { model: def.model } : {}),
    ...(def.effort ? { effort: def.effort as never } : {}),
    ...(def.providerId ? { provider: def.providerId } : {}),
  };
  let handle: PluginChatRunHandle | null = null;
  try {
    // send 走宿主聊天发送路径：会话进侧栏、流式进 bySession、可停。
    await store.send(prompt, [], {
      onStarted: (info) => {
        handle = info;
        runs.set(info.runId, { pluginId, engine, workspacePath, sessionId: info.sessionId });
        // started 先于 send 返回发出：插件在 startRun resolve 前就能把轮次
        // 认领到自己的任务上，之后不会漏掉紧跟的 done/error。
        pluginBus.emit(`plugin-run://${pluginId}`, {
          runId: info.runId,
          sessionId: info.sessionId,
          engine,
          workspacePath,
          kind: "started",
          error: null,
        });
      },
    }, target);
  } catch (error) {
    if (handle) runs.delete((handle as PluginChatRunHandle).runId);
    throw error;
  }
  if (!handle) {
    // 理论上不可达：send 成功返回时 onStarted 已经跑过。
    throw new Error(`${pluginId}: host did not report the run identity`);
  }
  return handle;
}

export async function interruptPluginChatRun(
  pluginId: string,
  def: { engine: string; workspacePath: string; sessionId?: string | null },
): Promise<void> {
  const engine = def.engine?.trim();
  const workspacePath = def.workspacePath?.trim();
  if (!engine || !workspacePath) {
    throw new Error(`invalid_args: ${pluginId} sessions.interruptRun: engine and workspacePath are required`);
  }
  // Ownership gate: the store's interrupt is session-scoped, so forwarding
  // blindly would let any plugin with host:session stop the user's or a
  // sibling plugin's turn. Only a live run this plugin started may be
  // stopped. `sessionId: null` matches any live run of this plugin in the
  // scope because the native id is often announced after startRun resolves.
  const sessionId = def.sessionId ?? null;
  const owned = [...runs.values()].some(
    (record) =>
      record.pluginId === pluginId &&
      record.engine === engine &&
      record.workspacePath === workspacePath &&
      (sessionId === null || record.sessionId === sessionId),
  );
  if (!owned) {
    throw new Error(
      `${pluginId}: sessions.interruptRun may only stop a run started by this plugin`,
    );
  }
  const chat = await import("@/features/chat/store");
  // 等价于聊天里的停止：sessionId 未知（尚未 announce）时按待发键停，
  // 与聊天栏在 spawn 前就能点停止是同一条路径。
  await chat.useChatStore.getState().interrupt({
    engine,
    sessionId: def.sessionId ?? null,
    workspacePath,
  });
}
