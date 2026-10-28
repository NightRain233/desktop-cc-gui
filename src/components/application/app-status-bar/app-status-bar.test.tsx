import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effect import: initializes the i18next instance useTranslation reads.
import i18n from "@/lib/i18n";

// Minimal stubs: the status bar polls ipc.appMetrics / rescanSessions and
// subscribes via listenScanProgress; none of that is under test here.
vi.mock("@/lib/ipc", () => ({
  ipc: {
    appMetrics: vi.fn(() => Promise.withResolvers<unknown>().promise),
    rescanSessions: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("@/lib/events", () => ({
  listenScanProgress: vi.fn(() => Promise.resolve(() => {})),
}));

// Web fallback paths would open a real WebSocket bridge in jsdom; stub them.
vi.mock("@/lib/platform", () => ({
  isWeb: true,
  getAppVersion: vi.fn(() => Promise.resolve(null)),
  setWebviewZoom: vi.fn(),
  pickFile: vi.fn(async () => null),
}));

import { AppStatusBar } from "./app-status-bar";
import { getAppVersion } from "@/lib/platform";
import { statusBarRegistry } from "@ccgui/plugin-sdk";
import type { Disposer } from "@ccgui/plugin-sdk";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("AppStatusBar plugin items (plan §4.2 #8)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const disposers: Disposer[] = [];

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AppStatusBar />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      while (disposers.length) disposers.pop()!();
      root.unmount();
    });
    container.remove();
  });

  it("renders a registered StatusBarItemDef and removes it on dispose", async () => {
    // Registration notifies useRegistry subscribers synchronously; wrapping
    // the write in act flushes the resulting re-render.
    await act(async () => {
      disposers.push(
        statusBarRegistry.register({
          id: "plugin:test-plugin:chip",
          component: () => <span>PLUGIN CHIP</span>,
        }),
      );
    });
    expect(container.textContent).toContain("PLUGIN CHIP");

    await act(async () => {
      disposers.pop()!();
    });
    expect(container.textContent).not.toContain("PLUGIN CHIP");
  });

  it("orders chips by their order field", async () => {
    await act(async () => {
      disposers.push(
        statusBarRegistry.register({
          id: "plugin:a:late",
          order: 20,
          component: () => <span>LATE</span>,
        }),
        statusBarRegistry.register({
          id: "plugin:b:early",
          order: 1,
          component: () => <span>EARLY</span>,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text.indexOf("EARLY")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("EARLY")).toBeLessThan(text.indexOf("LATE"));
  });
  it("places zone:\"start\" chips in the left zone ahead of the builtin cluster", async () => {
    await act(async () => {
      disposers.push(
        statusBarRegistry.register({
          id: "plugin:z:left",
          zone: "start",
          component: () => <span>LEFT CHIP</span>,
        }),
        statusBarRegistry.register({
          id: "plugin:z:right",
          component: () => <span>RIGHT CHIP</span>,
        }),
      );
    });
    // The left zone is the me-auto container that pushes builtins right.
    expect(container.querySelector(".me-auto")?.textContent).toContain("LEFT CHIP");
    expect(container.querySelector(".me-auto")?.textContent).not.toContain("RIGHT CHIP");
    const text = container.textContent ?? "";
    expect(text.indexOf("LEFT CHIP")).toBeLessThan(text.indexOf("RIGHT CHIP"));
  });

  it("a crashing chip unmounts itself without taking down the rest of the bar", async () => {
    // The boundary and React both console.error on a caught render crash.
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        disposers.push(
          statusBarRegistry.register({
            id: "plugin:crasher",
            component: () => {
              throw new Error("boom");
            },
          }),
        );
      });
      // Builtin items still render (metrics label); the crashed chip is gone.
      expect(container.textContent).toContain(i18n.t("statusbar.performance"));
      expect(container.firstElementChild).not.toBeNull();
    } finally {
      silence.mockRestore();
    }
  });
});
describe("AppStatusBar slimmed chrome", () => {
  it("keeps version and zoom controls out of the bar", async () => {
    vi.mocked(getAppVersion).mockResolvedValue("1.0.2");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<AppStatusBar />);
      });
      // 版本号在 设置 → 更新，缩放走快捷键 / 设置页：状态栏都不再常驻。
      expect(container.textContent).not.toContain("v1.0.2");
      expect(container.querySelector(`[aria-label="${i18n.t("statusbar.zoomIn")}"]`)).toBeNull();
      expect(container.querySelector(`[aria-label="${i18n.t("statusbar.zoomOut")}"]`)).toBeNull();
      // 性能标签只在悬停 / 聚焦时展开，常态只剩图标。
      const perf = container.querySelector(`[aria-label="${i18n.t("diagnostics.open")}"]`);
      expect(perf?.className).toContain("group");
      expect(perf?.querySelector("span")?.className).toContain("hidden");
    } finally {
      vi.mocked(getAppVersion).mockResolvedValue(null);
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
