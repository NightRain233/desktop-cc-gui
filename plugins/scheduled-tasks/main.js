/**
 * CC GUI Tier-1 scheduled task plugin.
 * The bundle deliberately has no imports: it is installed as a local plugin
 * directory and runs with the host React instance supplied by PluginContext.
 */
export default function activate(ctx) {
  const { createElement: h, useEffect, useState } = ctx.react;
  const timers = new Map();
  const runToTask = new Map();
  let alive = true;
  let tasks = [];

  const now = () => Date.now();
  const id = () => `task-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const copy = (value) => JSON.parse(JSON.stringify(value));

  async function persist() {
    if (alive) await ctx.storage.set("tasks", copy(tasks));
  }

  function clearTimer(taskId) {
    const timer = timers.get(taskId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(taskId);
  }

  function nextOccurrence(task, from) {
    if (task.schedule.kind === "once") return task.nextRunAt;
    if (task.schedule.kind === "interval") {
      const every = Math.max(1000, Number(task.schedule.everyMs) || 0);
      return Math.max(from + every, Number(task.nextRunAt) || from + every);
    }
    const [hour, minute] = String(task.schedule.time || "00:00").split(":").map(Number);
    const next = new Date(from);
    next.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  function updateTask(taskId, patch) {
    tasks = tasks.map((task) => task.id === taskId ? { ...task, ...patch } : task);
  }

  async function execute(taskId) {
    const task = tasks.find((entry) => entry.id === taskId);
    if (!alive || !task || !task.enabled) return;
    clearTimer(taskId);
    const scheduledAt = task.nextRunAt;
    const next = task.schedule.kind === "once" ? null : nextOccurrence(task, scheduledAt || now());
    updateTask(taskId, {
      nextRunAt: next,
      lastResult: { status: "running", at: now(), error: null },
      enabled: task.schedule.kind === "once" ? false : task.enabled,
    });
    await persist();
    try {
      const result = await ctx.sessions.sendMessage({
        engine: task.engine,
        sessionId: task.sessionId,
        workspacePath: task.workspacePath,
        prompt: task.prompt,
        ifBusy: task.ifBusy || "queue",
      });
      runToTask.set(result.runId, taskId);
      updateTask(taskId, { lastResult: { status: "started", at: now(), runId: result.runId, error: null } });
      await persist();
    } catch (error) {
      updateTask(taskId, { lastResult: { status: "error", at: now(), error: String(error) } });
      await persist();
      arm(taskId);
    }
  }

  function arm(taskId) {
    clearTimer(taskId);
    const task = tasks.find((entry) => entry.id === taskId);
    if (!alive || !task || !task.enabled || !task.nextRunAt) return;
    const delay = Math.max(0, Math.min(task.nextRunAt - now(), 2147483647));
    timers.set(taskId, setTimeout(() => {
      timers.delete(taskId);
      void execute(taskId);
    }, delay));
  }

  async function load() {
    const stored = await ctx.storage.get("tasks");
    if (!alive) return;
    tasks = Array.isArray(stored) ? stored.filter((task) => task && typeof task.id === "string") : [];
    const current = now();
    for (const task of tasks) {
      if (!task.enabled || !task.nextRunAt) continue;
      if (task.nextRunAt <= current) {
        if (task.missedPolicy === "run_once") void execute(task.id);
        else {
          updateTask(task.id, { nextRunAt: nextOccurrence(task, current), lastResult: { status: "skipped", at: current, error: "missed while app was closed" } });
          arm(task.id);
        }
      } else arm(task.id);
    }
    await persist();
  }

  const unsubscribe = ctx.events.on(`plugin-run://${ctx.pluginId}`, (event) => {
    if (!event || typeof event !== "object") return;
    const taskId = runToTask.get(event.runId);
    if (!taskId) return;
    if (event.kind === "done") updateTask(taskId, { lastResult: { status: "done", at: now(), runId: event.runId, error: null } });
    else if (event.kind === "error" || event.kind === "cancelled") updateTask(taskId, { lastResult: { status: event.kind, at: now(), runId: event.runId, error: event.error || "send failed" } });
    runToTask.delete(event.runId);
    void persist().then(() => arm(taskId));
  });

  function Panel() {
    const [, redraw] = useState(0);
    useEffect(() => {
      const timer = setInterval(() => redraw((value) => value + 1), 1000);
      return () => clearInterval(timer);
    }, []);
    const [draft, setDraft] = useState({ name: "", engine: "", sessionId: "", workspacePath: "", prompt: "", at: "", everyMs: "", kind: "once", ifBusy: "queue", missedPolicy: "skip" });
    const [editingId, setEditingId] = useState(null);
    const add = () => {
      if (!draft.engine || !draft.sessionId || !draft.workspacePath || !draft.prompt) return;
      const next = draft.kind === "once" ? new Date(draft.at).getTime() : draft.kind === "interval" ? now() + Math.max(1000, Number(draft.everyMs) || 0) : nextOccurrence({ schedule: { kind: "daily", time: draft.at || "09:00" }, nextRunAt: now() }, now());
      if (!Number.isFinite(next)) return;
      const replacement = { name: draft.name || "定时任务", engine: draft.engine, sessionId: draft.sessionId, workspacePath: draft.workspacePath, prompt: draft.prompt, ifBusy: draft.ifBusy, missedPolicy: draft.missedPolicy, enabled: true, schedule: { kind: draft.kind, everyMs: Number(draft.everyMs) || undefined, time: draft.at || undefined }, nextRunAt: next, lastResult: null };
      const taskId = editingId || id();
      if (editingId) {
        clearTimer(editingId);
        updateTask(editingId, replacement);
      } else tasks = [...tasks, { id: taskId, ...replacement }];
      void persist().then(() => arm(taskId));
      setDraft({ ...draft, name: "", prompt: "" });
      setEditingId(null);
      redraw((value) => value + 1);
    };
    const remove = (taskId) => { clearTimer(taskId); tasks = tasks.filter((task) => task.id !== taskId); void persist(); redraw((value) => value + 1); };
    const toggle = (task) => { updateTask(task.id, { enabled: !task.enabled }); if (task.enabled) clearTimer(task.id); else arm(task.id); void persist(); redraw((value) => value + 1); };
    const edit = (task) => { setEditingId(task.id); setDraft({ name: task.name || "", engine: task.engine, sessionId: task.sessionId, workspacePath: task.workspacePath, prompt: task.prompt, at: task.schedule.time || (task.nextRunAt ? new Date(task.nextRunAt).toISOString().slice(0, 16) : ""), everyMs: String(task.schedule.everyMs || ""), kind: task.schedule.kind, ifBusy: task.ifBusy || "queue", missedPolicy: task.missedPolicy || "skip" }); };
    return h("div", { style: { padding: 16, overflow: "auto", height: "100%" } },
      h("h2", null, "定时任务"),
      h("p", null, "自动发送会消耗模型额度。任务只会发送到你明确填写的已有会话。"),
      h("div", { style: { display: "grid", gap: 6, maxWidth: 560 } },
        ["name", "engine", "sessionId", "workspacePath", "prompt", "at", "everyMs"].map((field) => h("input", { key: field, placeholder: field, value: draft[field], onChange: (event) => setDraft({ ...draft, [field]: event.target.value }) })),
        h("select", { value: draft.kind, onChange: (event) => setDraft({ ...draft, kind: event.target.value }) }, h("option", { value: "once" }, "一次性"), h("option", { value: "interval" }, "按间隔"), h("option", { value: "daily" }, "每天固定时间")),
        h("select", { value: draft.ifBusy, onChange: (event) => setDraft({ ...draft, ifBusy: event.target.value }) }, h("option", { value: "queue" }, "忙碌时排队"), h("option", { value: "reject" }, "忙碌时失败")),
        h("select", { value: draft.missedPolicy, onChange: (event) => setDraft({ ...draft, missedPolicy: event.target.value }) }, h("option", { value: "skip" }, "关闭期间跳过"), h("option", { value: "run_once" }, "启动后补跑一次")),
        h("button", { onClick: add }, editingId ? "保存修改" : "添加任务"), editingId && h("button", { onClick: () => setEditingId(null) }, "取消编辑")),
      h("ul", null, tasks.map((task) => h("li", { key: task.id }, `${task.name} · ${task.enabled ? "启用" : "停用"} · 下次 ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—"} · ${task.lastResult?.status || "未执行"} `, h("button", { onClick: () => toggle(task) }, task.enabled ? "停用" : "启用"), h("button", { onClick: () => edit(task) }, "编辑"), h("button", { onClick: () => remove(task.id) }, "删除")))));
  }

  ctx.ui.registerPanelTab({ label: () => "定时任务", component: Panel });
  void load();
  return () => {
    alive = false;
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    runToTask.clear();
  };
}
