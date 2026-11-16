// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginThreadActionEntry } from "@get-bb/plugin-sdk/app";
import { DEFAULT_RING_ACTIONS, type RingAction } from "./ring-actions";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const app = await loadPluginApp(() => import("./app"));
const { QuickActionsOverlay } = await import("./app");
const THREAD_ID = "thr_test";
const PROJECT_ID = "proj_test";
let now = 0;
let nextFrame = 1;
let frames = new Map<number, FrameRequestCallback>();
let resizeObserverCallback: (() => void) | null = null;
let resizeObserverDisconnects = 0;

beforeEach(() => {
  now = 0;
  nextFrame = 1;
  frames = new Map();
  resizeObserverCallback = null;
  resizeObserverDisconnects = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeObserverCallback = callback;
      }
      observe() {}
      disconnect() {
        resizeObserverDisconnects++;
      }
    },
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function advance(milliseconds = 800) {
  const end = now + milliseconds;
  while (now < end) {
    now += 40;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(async () => {
      for (const callback of callbacks) callback(now);
    });
    if (callbacks.length === 0) break;
  }
}

function actionEntry(
  key: string,
  label: string,
  run: (value?: string) => Promise<void>,
): PluginThreadActionEntry {
  return {
    key,
    pluginId: "bb--core",
    group: "state",
    action: { label, icon: key, run },
  };
}

/** A thread action a fake plugin registers with BB. */
type PluginAction = {
  key: string;
  action: PluginThreadActionEntry["action"];
  /** False for an action the user hasn't put in the ring. */
  inRing?: boolean;
  /** False when the action's `item` returns null for the thread. */
  forThread?: boolean;
};

/** The saved ring: BB's four, with ring plugin actions right after Archive. */
function savedRing(pluginActions: readonly PluginAction[]): RingAction[] | null {
  const added = pluginActions
    .filter((plugin) => plugin.inRing !== false)
    .map((plugin) => ({ key: plugin.key, title: plugin.action.label, icon: plugin.action.icon }));
  if (added.length === 0) return null;
  const [archive, ...rest] = DEFAULT_RING_ACTIONS;
  return [archive!, ...added, ...rest];
}

/** Workstreams-style Snooze: presets as choices, `detail` naming the default. */
function snoozeAction(
  overrides: Partial<PluginThreadActionEntry["action"]> = {},
): PluginThreadActionEntry["action"] {
  return {
    label: "Snooze",
    icon: "Clock",
    detail: "3 hours",
    choices: { items: SNOOZE_PRESETS },
    run: vi.fn(async (_value?: string) => undefined),
    ...overrides,
  };
}

const SNOOZE_PRESETS = [
  { id: "20m", label: "20 minutes" },
  { id: "1h", label: "1 hour" },
  { id: "3h", label: "3 hours" },
  { id: "tomorrow", label: "Tomorrow morning" },
  { id: "next-week", label: "Next week" },
];

async function renderQuickActions({
  settings = { trigger: "corner", corner: "bottom-left", motion: "ring" },
  archivedAt = null,
  strictMode = false,
  pluginActions = [],
  ring = savedRing(pluginActions),
}: {
  settings?: Record<string, string | number | boolean>;
  archivedAt?: number | null;
  strictMode?: boolean;
  pluginActions?: readonly PluginAction[];
  /** The saved ring; null for the default. */
  ring?: RingAction[] | null;
} = {}) {
  const runs = new Map<string, (value?: string) => Promise<void>>();
  const definitions = [
    ["bb--core/archive", archivedAt === null ? "Archive" : "Unarchive"],
    ["bb--core/pin", "Pin"],
    ["bb--core/read", "Mark unread"],
    ["bb--core/copyLink", "Copy link"],
  ] as const;
  const entries = definitions.map(([key, label]) => {
    const run = vi.fn(async (_value?: string) => undefined);
    runs.set(key, run);
    return actionEntry(key, label, run);
  });
  for (const { key, action, forThread = true } of pluginActions) {
    if (!forThread) continue;
    entries.push({
      key,
      pluginId: key.split("/")[0]!,
      group: "1_state",
      action,
    });
  }
  const registrations = [
    ...definitions.map(([key, label]) => ({ key, pluginId: "bb--core", title: label, icon: key })),
    ...pluginActions.map(({ key, action }) => ({
      key,
      pluginId: key.split("/")[0]!,
      title: action.label,
      icon: action.icon,
    })),
  ];
  const stored = { ring };
  const thread = makeThreadResponse({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    archivedAt,
    lastReadAt: 0,
    latestAttentionAt: 0,
    title: "Fix flaky retry test",
  });
  const registration = strictMode
    ? {
        ...app.appOverlays[0]!,
        component: () => {
          const Overlay = app.appOverlays[0]!.component;
          return (
            <StrictMode>
              <Overlay />
            </StrictMode>
          );
        },
      }
    : app.appOverlays[0]!;
  const slot = renderSlot(
    registration,
    {},
    {
      context: { projectId: PROJECT_ID, threadId: THREAD_ID },
      settings,
      sdk: { threads: { get: async () => thread } },
      threadActions: () => entries,
      threadActionRegistrations: registrations,
      rpc: { ringActions: async () => ({ actions: stored.ring }) },
    },
  );
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((call) => call.method === "ringActions")).toBe(true),
  );
  await act(async () => undefined);
  if (sanitizeTriggerForTest(settings.trigger) === "hold-option") {
    await waitFor(() =>
      expect(document.querySelector(".qa-hold")).not.toBeNull(),
    );
  } else {
    await slot.findByRole("group", { name: "Quick actions" });
  }
  const trigger = slot.queryByRole("button", {
    name: "Open quick actions",
  });
  return { slot, trigger: trigger as HTMLElement, runs, stored };
}

function sanitizeTriggerForTest(value: unknown) {
  return value === "corner" ? "corner" : "hold-option";
}

async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerEnter(trigger);
}

describe("Quick Actions overlay", () => {
  it("renders only when a thread is open", () => {
    const slot = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        context: { projectId: null, threadId: null },
      },
    );
    expect(slot.container).toBeEmptyDOMElement();
    slot.lifecycle.unmount();
  });

  it("keeps the trigger mounted when thread actions are unavailable", async () => {
    const thread = makeThreadResponse({
      id: THREAD_ID,
      projectId: PROJECT_ID,
      archivedAt: 1,
    });
    const slot = renderSlot(
      { component: QuickActionsOverlay },
      { threadId: THREAD_ID },
      {
        context: { projectId: PROJECT_ID, threadId: THREAD_ID },
        settings: { trigger: "corner" },
        sdk: { threads: { get: async () => thread } },
        threadActions: () => [],
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Open quick actions",
    });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".qa-menu")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(document.querySelector(".qa-menu")).toHaveAttribute(
      "data-can-open",
      "false",
    );
    slot.lifecycle.unmount();
  });

  it("keeps the same trigger mounted and disables it during navigation", async () => {
    const firstThread = makeThreadResponse({
      id: THREAD_ID,
      projectId: PROJECT_ID,
    });
    const secondThread = makeThreadResponse({
      id: "thr_second",
      projectId: PROJECT_ID,
    });
    let resolveSecond: ((thread: typeof secondThread) => void) | undefined;
    const secondResult = new Promise<typeof secondThread>((resolve) => {
      resolveSecond = resolve;
    });
    const run = vi.fn(async () => undefined);
    const entries = [
      actionEntry("bb--core/archive", "Archive", run),
      actionEntry("bb--core/pin", "Pin", run),
      actionEntry("bb--core/read", "Mark unread", run),
      actionEntry("bb--core/copyLink", "Copy link", run),
    ];
    const footer = document.createElement("div");
    footer.setAttribute("data-scroll-footer", "");
    footer.getBoundingClientRect = () =>
      ({ left: 320, right: 1100, top: 517 }) as DOMRect;
    document.body.append(footer);
    const slot = renderSlot(
      { component: QuickActionsOverlay },
      { threadId: THREAD_ID },
      {
        context: { projectId: PROJECT_ID, threadId: THREAD_ID },
        settings: { trigger: "corner", corner: "bottom-left", motion: "ring" },
        sdk: {
          threads: {
            get: async ({ threadId }: { threadId: string }) =>
              threadId === THREAD_ID ? firstThread : secondResult,
          },
        },
        threadActions: () => entries,
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Open quick actions",
    });
    await openMenu(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const oldArchive = slot.getByRole("button", { name: "Archive" });
    await act(async () => trigger.focus());
    const user = userEvent.setup();
    await user.tab();
    expect(oldArchive).toHaveFocus();
    const menu = document.querySelector<HTMLElement>(".qa-menu");
    expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("336px");
    footer.remove();

    slot.lifecycle.rerender(<QuickActionsOverlay threadId="thr_second" />);

    expect(
      slot.getByRole("button", { name: "Open quick actions" }),
    ).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("336px");
    expect(document.getElementById("qa-actions")).toHaveAttribute("inert", "");
    fireEvent.pointerEnter(trigger);
    fireEvent.click(oldArchive);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(run).not.toHaveBeenCalled();

    resolveSecond?.(secondThread);
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-disabled", "false"),
    );
    expect(document.querySelector(".qa-menu")).toHaveAttribute(
      "data-can-open",
      "true",
    );
    expect(slot.inspection.sdkCalls.flatMap((call) => call.args)).toContainEqual(
      expect.objectContaining({ threadId: "thr_second" }),
    );
    slot.lifecycle.unmount();
  });

  it("holds the pending action lock across navigation", async () => {
    const firstThread = makeThreadResponse({
      id: THREAD_ID,
      projectId: PROJECT_ID,
    });
    const secondThread = makeThreadResponse({
      id: "thr_second",
      projectId: PROJECT_ID,
    });
    let finishFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstRun = vi.fn(() => firstPending);
    const secondRun = vi.fn(async () => undefined);
    const slot = renderSlot(
      { component: QuickActionsOverlay },
      { threadId: THREAD_ID },
      {
        context: { projectId: PROJECT_ID, threadId: THREAD_ID },
        settings: { trigger: "corner" },
        sdk: {
          threads: {
            get: async ({ threadId }: { threadId: string }) =>
              threadId === THREAD_ID ? firstThread : secondThread,
          },
        },
        threadActions: (target) => [
          actionEntry(
            "bb--core/pin",
            "Pin",
            target.id === THREAD_ID ? firstRun : secondRun,
          ),
        ],
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Open quick actions",
    });
    await openMenu(trigger);
    const user = userEvent.setup();
    await user.click(slot.getByRole("button", { name: "Pin" }));
    expect(firstRun).toHaveBeenCalledOnce();

    slot.lifecycle.rerender(<QuickActionsOverlay threadId="thr_second" />);
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-disabled", "false"),
    );
    await openMenu(trigger);
    const secondPin = slot.getByRole("button", { name: "Pin" });
    expect(secondPin).toBeDisabled();
    await user.click(secondPin);
    expect(secondRun).not.toHaveBeenCalled();

    finishFirst?.();
    await waitFor(() => expect(secondPin).not.toBeDisabled());
    await user.click(secondPin);
    expect(secondRun).toHaveBeenCalledOnce();
    slot.lifecycle.unmount();
  });

  it("uses configured motion and corner", async () => {
    const { slot } = await renderQuickActions({
      settings: { trigger: "corner", corner: "top-right", motion: "arc" },
    });
    const menu = document.querySelector(".qa-menu");
    expect(menu).toHaveAttribute("data-corner", "top-right");
    expect(menu).toHaveAttribute("data-motion", "arc");
    slot.lifecycle.unmount();
  });

  it("renders debug hover regions only when enabled", async () => {
    const { slot } = await renderQuickActions({
      settings: { trigger: "corner", debugRegions: true },
    });
    const menu = document.querySelector(".qa-menu");
    expect(menu).toHaveAttribute("data-debug", "true");
    expect(document.querySelector(".qa-hover-core")).not.toBeNull();
    expect(document.querySelectorAll(".qa-hover-corridor")).toHaveLength(4);
    slot.lifecycle.unmount();
  });

  it("sanitizes each unknown stored setting", async () => {
    await renderQuickActions({
      settings: { trigger: "unknown", corner: "unknown", motion: "unknown" },
    });
    expect(document.querySelector(".qa-menu")).toBeNull();
    expect(document.querySelector(".qa-hold")).toHaveAttribute(
      "data-trigger",
      "hold-option",
    );
  });

  it("reanchors a title-bar-safe trigger when the footer mounts late", async () => {
    const threadWindow = document.createElement("div");
    threadWindow.setAttribute("data-thread-window", "");
    threadWindow.getBoundingClientRect = () => ({ top: 48 }) as DOMRect;
    document.body.append(threadWindow);
    const { slot } = await renderQuickActions({
      settings: { trigger: "corner", corner: "top-left", motion: "ring" },
    });
    const menu = document.querySelector<HTMLElement>(".qa-menu");
    expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("16px");
    expect(menu?.style.getPropertyValue("--qa-menu-y")).toBe("112px");

    const footer = document.createElement("div");
    footer.setAttribute("data-scroll-footer", "");
    footer.getBoundingClientRect = () =>
      ({
        left: 320,
        right: 1100,
        top: 517,
      }) as DOMRect;
    threadWindow.append(footer);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await advance(40);

    expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("336px");
    expect(menu?.style.getPropertyValue("--qa-menu-y")).toBe("112px");
    slot.lifecycle.unmount();
    threadWindow.remove();
  });

  it("anchors to the thread footer and follows observed resizing", async () => {
    const footerRect = { left: 320, right: 1100, top: 517 };
    const windowRect = { top: 0, bottom: 800 };
    const threadWindow = document.createElement("div");
    threadWindow.setAttribute("data-thread-window", "");
    const footer = document.createElement("div");
    footer.setAttribute("data-scroll-footer", "");
    threadWindow.append(footer);
    document.body.append(threadWindow);
    const rect = (values: {
      left?: number;
      right?: number;
      top?: number;
      bottom?: number;
    }) => {
      const left = values.left ?? 0;
      const top = values.top ?? 0;
      const right = values.right ?? left;
      const bottom = values.bottom ?? top;
      return {
        x: left,
        y: top,
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    footer.getBoundingClientRect = () => rect(footerRect);
    threadWindow.getBoundingClientRect = () => rect(windowRect);
    const { slot } = await renderQuickActions();
    const menu = document.querySelector<HTMLElement>(".qa-menu");
    expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("336px");
    expect(menu?.style.getPropertyValue("--qa-menu-y")).toBe("457px");
    footerRect.left = 400;
    footerRect.top = 567;
    await act(async () => resizeObserverCallback?.());
    await advance(40);
    expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("416px");
    expect(menu?.style.getPropertyValue("--qa-menu-y")).toBe("507px");
    slot.lifecycle.unmount();
    threadWindow.remove();
  });

  it("disconnects idle footer discovery without scheduling layout frames", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { slot } = await renderQuickActions();
    expect(frames.size).toBe(0);

    slot.lifecycle.unmount();

    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
  });

  it("cancels a scheduled anchor update on unmount", async () => {
    const footer = document.createElement("div");
    footer.setAttribute("data-scroll-footer", "");
    document.body.append(footer);
    const { slot } = await renderQuickActions();
    expect(frames.size).toBe(0);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      resizeObserverCallback?.();
    });
    expect(frames.size).toBe(1);

    slot.lifecycle.unmount();

    expect(frames.size).toBe(0);
    expect(resizeObserverDisconnects).toBeGreaterThan(0);
    await advance(40);
    footer.remove();
  });

  it("runs BB's native thread actions", async () => {
    const user = userEvent.setup();
    const { slot, trigger, runs } = await renderQuickActions();
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Pin" }));
    await user.click(slot.getByRole("button", { name: "Mark unread" }));
    expect(runs.get("bb--core/pin")).toHaveBeenCalledOnce();
    expect(runs.get("bb--core/read")).toHaveBeenCalledOnce();
    expect(runs.get("bb--core/archive")).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });

  it("shows the saved ring, and keeps it after StrictMode effect replay", async () => {
    const action = snoozeAction();
    const { slot, trigger } = await renderQuickActions({
      strictMode: true,
      pluginActions: [{ key: "workstreams/snooze", action }],
    });
    await openMenu(trigger);
    expect(
      slot.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Close quick actions",
      "Archive",
      "Snooze",
      "Pin",
      "Mark unread",
      "Copy link",
    ]);
    slot.lifecycle.unmount();
  });

  it("runs a ring action's default choice from the corner menu", async () => {
    const user = userEvent.setup();
    const action = snoozeAction();
    const { slot, trigger } = await renderQuickActions({
      pluginActions: [{ key: "workstreams/snooze", action }],
    });
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    expect(action.run).toHaveBeenCalledExactlyOnceWith("3h");
    slot.lifecycle.unmount();
  });

  it("shows BB's four actions until the user adds another", async () => {
    const { slot, trigger } = await renderQuickActions({
      pluginActions: [{ key: "workstreams/snooze", action: snoozeAction(), inRing: false }],
    });
    await openMenu(trigger);
    expect(slot.queryByRole("button", { name: "Snooze" })).toBeNull();
    expect(slot.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    slot.lifecycle.unmount();
  });

  it("follows a ring saved in another window", async () => {
    const { slot, trigger, stored } = await renderQuickActions({
      pluginActions: [{ key: "workstreams/snooze", action: snoozeAction(), inRing: false }],
    });
    stored.ring = savedRing([{ key: "workstreams/snooze", action: snoozeAction() }]);
    await slot.behavior.emitRealtime("ring-actions", null);
    await openMenu(trigger);
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Snooze" })).toBeInTheDocument(),
    );
    slot.lifecycle.unmount();
  });

  it("keeps the slot of an action this thread doesn't have, unavailable", async () => {
    const { slot, trigger } = await renderQuickActions({
      pluginActions: [{ key: "workstreams/snooze", action: snoozeAction(), forThread: false }],
    });
    await openMenu(trigger);
    expect(slot.getByRole("button", { name: "Snooze" })).toBeDisabled();
    expect(
      slot.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toHaveLength(6);
    slot.lifecycle.unmount();
  });

  it("names an action whose plugin is gone by its saved title", async () => {
    const { slot, trigger } = await renderQuickActions({
      ring: [
        ...DEFAULT_RING_ACTIONS,
        { key: "gone/action", title: "Triage", icon: "Inbox" },
      ],
    });
    await openMenu(trigger);
    expect(slot.getByRole("button", { name: "Triage" })).toBeDisabled();
    slot.lifecycle.unmount();
  });

  it("reports an action that fails", async () => {
    const user = userEvent.setup();
    const { slot, trigger, runs } = await renderQuickActions();
    vi.mocked(runs.get("bb--core/pin")!).mockRejectedValueOnce(new Error("offline"));
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Pin failed: offline"),
    );
    slot.lifecycle.unmount();
  });

  it("keeps focused actions open on pointer exit and makes closed actions inert", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions();
    const actions = document.getElementById("qa-actions");
    expect(actions).toHaveAttribute("inert", "");
    await openMenu(trigger);
    expect(actions).not.toHaveAttribute("inert");
    await act(async () => trigger.focus());
    await user.tab();
    const menu = document.querySelector(".qa-menu");
    fireEvent.pointerLeave(menu!);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await advance();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toHaveAttribute("aria-label", "Archive");
    await user.keyboard("{Escape}");
    await advance();
    expect(actions).toHaveAttribute("inert", "");
    slot.lifecycle.unmount();
  });

  it("cancels hover closing on re-entry", async () => {
    const { slot, trigger } = await renderQuickActions();
    await openMenu(trigger);
    const menu = document.querySelector(".qa-menu");
    fireEvent.pointerLeave(menu!);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerEnter(menu!);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await advance();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerLeave(menu!);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await advance();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    slot.lifecycle.unmount();
  });

  it("puts actions in tab order as soon as the trigger receives focus", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions();
    await act(async () => trigger.focus());
    expect(document.getElementById("qa-actions")).not.toHaveAttribute("inert");
    await user.tab();
    expect(document.activeElement).toHaveAttribute("aria-label", "Archive");
    slot.lifecycle.unmount();
  });

  it("closes on Escape without reopening from restored focus", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions();
    await openMenu(trigger);
    await act(async () => trigger.focus());
    await user.tab();
    expect(document.activeElement).toHaveAttribute("aria-label", "Archive");
    await user.keyboard("{Escape}");
    await advance();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    slot.lifecycle.unmount();
  });

  describe("the ring at the pointer", () => {
    const hold = { trigger: "hold-option" } as const;

    // jsdom has no layout, so hit testing follows a fixed window: a 240px
    // sidebar on the left, a 40px title bar across the rest of the top, and
    // the thread pane below it.
    let sidebar: HTMLElement;
    let titleBar: HTMLElement;
    let threadWindow: HTMLElement;
    let timeline: HTMLElement;
    let hitTest: (x: number, y: number) => Element[];

    beforeEach(() => {
      sidebar = document.createElement("aside");
      titleBar = document.createElement("header");
      threadWindow = document.createElement("div");
      threadWindow.setAttribute("data-thread-window", "");
      timeline = document.createElement("div");
      threadWindow.append(timeline);
      document.body.append(sidebar, titleBar, threadWindow);
      hitTest = (x, y) => [
        x < 240 ? sidebar : y < 40 ? titleBar : timeline,
        ...(x >= 240 && y >= 40 ? [threadWindow] : []),
        document.body,
        document.documentElement,
      ];
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: (x: number, y: number) => hitTest(x, y),
      });
    });

    afterEach(() => {
      sidebar.remove();
      titleBar.remove();
      threadWindow.remove();
      Reflect.deleteProperty(document, "elementsFromPoint");
    });

    async function holdOptionAt(point: { clientX: number; clientY: number }) {
      fireEvent.pointerMove(window, point);
      await act(async () => {
        fireEvent.keyDown(window, { key: "Alt" });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 260));
      });
    }

    async function pointAt(point: { clientX: number; clientY: number }) {
      await act(async () => {
        fireEvent.pointerMove(window, point);
      });
    }

    async function releaseOption() {
      await act(async () => {
        fireEvent.keyUp(window, { key: "Alt" });
      });
    }

    const ring = () => document.querySelector<HTMLElement>(".qa-ring");
    const item = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(".qa-ring-item")).find(
        (node) => node.textContent?.startsWith(label),
      );

    it("renders no corner trigger and opens centred on the pointer after a hold", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      expect(
        slot.queryByRole("button", { name: "Open quick actions" }),
      ).toBeNull();
      expect(ring()).toBeNull();

      await holdOptionAt({ clientX: 400, clientY: 300 });

      expect(ring()).not.toBeNull();
      expect(ring()?.style.left).toBe("400px");
      expect(ring()?.style.top).toBe("300px");
      expect(document.querySelector(".qa-dim")).toHaveAttribute("data-state", "on");
      slot.lifecycle.unmount();
    });

    it("stays centred on the pointer at the window edge", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 1436, clientY: 894 });
      expect(ring()?.style.left).toBe("1436px");
      expect(ring()?.style.top).toBe("894px");
      slot.lifecycle.unmount();
    });

    it("opens only over a thread pane, not the sidebar or title bar", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });

      // Option-clicking the green window button holds Option over the corner.
      await holdOptionAt({ clientX: 20, clientY: 18 });
      expect(ring()).toBeNull();
      expect(document.querySelector(".qa-dim")).toHaveAttribute("data-state", "off");
      await releaseOption();

      await holdOptionAt({ clientX: 120, clientY: 500 });
      expect(ring()).toBeNull();
      await releaseOption();

      await holdOptionAt({ clientX: 700, clientY: 20 });
      expect(ring()).toBeNull();
      await releaseOption();

      await holdOptionAt({ clientX: 700, clientY: 300 });
      expect(ring()).not.toBeNull();
      slot.lifecycle.unmount();
    });

    it("opens over a thread pane covered by a ring that is still closing", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 700, clientY: 300 });
      await releaseOption();
      const closingDisc = document.querySelector(".qa-ring-base");
      expect(closingDisc).not.toBeNull();
      const underneath = hitTest;
      hitTest = (x, y) => [closingDisc!, ...underneath(x, y)];

      await holdOptionAt({ clientX: 720, clientY: 310 });
      expect(ring()?.style.left).toBe("720px");
      slot.lifecycle.unmount();
    });

    it("ignores a quick tap of Option", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      fireEvent.pointerMove(window, { clientX: 400, clientY: 300 });
      await act(async () => {
        fireEvent.keyDown(window, { key: "Alt" });
      });
      await releaseOption();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 260));
      });
      expect(ring()).toBeNull();
      slot.lifecycle.unmount();
    });

    it("labels every action and selects by direction outside the hub", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      expect(
        slot.getByRole("menu", { name: "Quick actions for Fix flaky retry test" }),
      ).toBeInTheDocument();
      expect(document.querySelector(".qa-ring-title")).toHaveTextContent(
        "Fix flaky retry test",
      );
      const actionItems = slot
        .getAllByRole("menuitem")
        .filter((node) => !node.closest(".qa-band-items"));
      expect(actionItems).toHaveLength(4);
      expect(item("Archive")).toHaveAttribute("data-selected", "false");

      await pointAt({ clientX: 400, clientY: 280 });
      expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(0);

      await pointAt({ clientX: 400, clientY: 220 });
      expect(item("Archive")).toHaveAttribute("data-selected", "true");

      // Past Copy link, the last slot, the selection wraps the short way to Archive.
      await pointAt({ clientX: 390, clientY: 220 });
      expect(item("Archive")).toHaveAttribute("data-selected", "true");
      slot.lifecycle.unmount();
    });

    it("runs the selection at once when Option is released outside the hub", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 240 });
      await releaseOption();
      expect(runs.get("bb--core/archive")).toHaveBeenCalledOnce();
      expect(document.querySelector(".qa-dim")).toHaveAttribute("data-state", "off");
      await advance(400);
      expect(ring()).toBeNull();
      slot.lifecycle.unmount();
    });

    it("closes without running when Option is released in the hub", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await releaseOption();
      await advance(400);
      expect(ring()).toBeNull();
      for (const run of runs.values()) expect(run).not.toHaveBeenCalled();
      slot.lifecycle.unmount();
    });

    it("cancels with Escape and with a press outside the ring", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 240 });
      await act(async () => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      await releaseOption();
      await advance(400);
      expect(ring()).toBeNull();

      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 240 });
      await act(async () => {
        fireEvent.pointerDown(document.body);
      });
      await releaseOption();
      await advance(400);
      expect(ring()).toBeNull();
      expect(runs.get("bb--core/archive")).not.toHaveBeenCalled();
      slot.lifecycle.unmount();
    });

    it("vanishes in the same frame when the user types, ignoring modifiers", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await act(async () => {
        fireEvent.keyDown(window, { key: "Shift" });
      });
      expect(ring()).not.toBeNull();
      await act(async () => {
        fireEvent.keyDown(window, { key: "e" });
      });
      expect(ring()).toBeNull();
      expect(document.querySelector(".qa-dim")).toHaveAttribute(
        "data-state",
        "instant",
      );
      slot.lifecycle.unmount();
    });

    describe("a ring action with choices", () => {
      const centre = { clientX: 400, clientY: 300 };
      // Right after Archive, Snooze is the second of five slots, 72 degrees
      // clockwise from up.
      const towardSnooze = (r: number) => ({
        clientX: centre.clientX + r * Math.sin((72 * Math.PI) / 180),
        clientY: centre.clientY - r * Math.cos((72 * Math.PI) / 180),
      });
      const band = () => document.querySelector<SVGElement>(".qa-band");
      /** A point on the band in the direction of one of its choices. */
      const onBand = (label: string) => {
        const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(item(label)!.style.transform);
        const [x, y] = [Number(match![1]), Number(match![2])];
        const r = Math.hypot(x, y);
        return { clientX: centre.clientX + (x / r) * 180, clientY: centre.clientY + (y / r) * 180 };
      };
      const bandLabels = () =>
        Array.from(document.querySelectorAll(".qa-band-items .qa-ring-label")).map(
          (node) => node.textContent,
        );
      const renderWithSnooze = (action = snoozeAction(), forThread = true) =>
        renderQuickActions({
          settings: { ...hold },
          pluginActions: [{ key: "workstreams/snooze", action, forThread }],
        });

      it("grows a band of its choices past the hub, lights the default, and folds for another action", async () => {
        const { slot } = await renderWithSnooze();
        await holdOptionAt(centre);
        expect(bandLabels()).toEqual(SNOOZE_PRESETS.map((preset) => preset.label));
        expect(band()).not.toHaveAttribute("data-extended", "true");
        // Snooze alone carries the chevron that points to its band.
        expect(document.querySelectorAll(".qa-ring-more")).toHaveLength(1);
        expect(item("Snooze")?.querySelector(".qa-ring-more")).not.toBeNull();

        // Just out of the 36px hub Snooze is selected but the band stays folded.
        await pointAt(towardSnooze(42));
        expect(item("Snooze")).toHaveAttribute("data-selected", "true");
        expect(band()).toHaveAttribute("data-extended", "false");

        await pointAt(towardSnooze(52));
        expect(band()).toHaveAttribute("data-extended", "true");
        expect(item("Snooze")).toHaveAttribute("data-selected", "true");
        expect(item("3 hours")).toHaveAttribute("data-selected", "true");

        // Pin, the next slot clockwise.
        await pointAt({ clientX: 400 + 100 * Math.sin((144 * Math.PI) / 180), clientY: 300 - 100 * Math.cos((144 * Math.PI) / 180) });
        expect(item("Pin")).toHaveAttribute("data-selected", "true");
        expect(band()).toHaveAttribute("data-extended", "false");
        expect(item("3 hours")).toHaveAttribute("data-selected", "false");
        slot.lifecycle.unmount();
      });

      it("runs the choice under the pointer when Option is released", async () => {
        const action = snoozeAction();
        const { slot } = await renderWithSnooze(action);
        await holdOptionAt(centre);
        await pointAt(towardSnooze(100));
        await pointAt(onBand("Tomorrow morning"));
        expect(item("Tomorrow morning")).toHaveAttribute("data-selected", "true");
        expect(item("Snooze")).toHaveAttribute("data-selected", "true");
        await releaseOption();
        expect(action.run).toHaveBeenCalledExactlyOnceWith("tomorrow");
        slot.lifecycle.unmount();
      });

      it("takes the default choice from the action itself, before or after the band opens", async () => {
        const action = snoozeAction();
        const { slot } = await renderWithSnooze(action);
        await holdOptionAt(centre);
        await pointAt(towardSnooze(42));
        await releaseOption();
        expect(action.run).toHaveBeenLastCalledWith("3h");
        await advance(400);

        await holdOptionAt(centre);
        await pointAt(towardSnooze(100));
        await releaseOption();
        expect(action.run).toHaveBeenCalledTimes(2);
        expect(action.run).toHaveBeenLastCalledWith("3h");
        slot.lifecycle.unmount();
      });

      it("lights nothing and passes no value when no choice is the default", async () => {
        // A snoozed thread: Wake now first, and no default preset.
        const action = snoozeAction({
          detail: undefined,
          choices: { items: [{ id: "wake-now", label: "Wake now" }, ...SNOOZE_PRESETS] },
        });
        const { slot } = await renderWithSnooze(action);
        await holdOptionAt(centre);
        await pointAt(towardSnooze(52));
        expect(band()).toHaveAttribute("data-extended", "true");
        expect(
          document.querySelectorAll('.qa-band-items .qa-ring-item[data-selected="true"]'),
        ).toHaveLength(0);
        await releaseOption();
        expect(action.run).toHaveBeenCalledExactlyOnceWith(undefined);
        slot.lifecycle.unmount();
      });

      it("cancels without running on Escape, folding the band", async () => {
        const action = snoozeAction();
        const { slot } = await renderWithSnooze(action);
        await holdOptionAt(centre);
        await pointAt(towardSnooze(100));
        await pointAt(onBand("20 minutes"));
        await act(async () => {
          fireEvent.keyDown(window, { key: "Escape" });
        });
        expect(band()).toHaveAttribute("data-extended", "false");
        await releaseOption();
        await advance(400);
        expect(ring()).toBeNull();
        expect(action.run).not.toHaveBeenCalled();
        slot.lifecycle.unmount();
      });

      it("keeps an unavailable action's slot, without a band", async () => {
        const { slot } = await renderWithSnooze(snoozeAction(), false);
        await holdOptionAt(centre);
        expect(item("Snooze")).toHaveAttribute("aria-disabled", "true");
        expect(band()).toBeNull();
        slot.lifecycle.unmount();
      });

      it("marks an action with more choices than a band holds unavailable, and says why", async () => {
        const many = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: `Section ${i}` }));
        const action = snoozeAction({ label: "Move to section", detail: undefined, choices: { items: many } });
        const { slot } = await renderWithSnooze(action);
        await holdOptionAt(centre);
        expect(item("Move to section")).toHaveAttribute("aria-disabled", "true");
        expect(band()).toBeNull();
        await pointAt(towardSnooze(100));
        await releaseOption();
        expect(toast).toHaveBeenCalledWith("Move to section has more choices than the ring can show");
        expect(action.run).not.toHaveBeenCalled();
        slot.lifecycle.unmount();
      });

      it("gives each action with choices its own band", async () => {
        const move = {
          label: "Move to section",
          icon: "SectionMove",
          choices: {
            items: [
              { id: "inbox", label: "Inbox" },
              { id: "later", label: "Later" },
            ],
          },
          run: vi.fn(async (_value?: string) => undefined),
        };
        const { slot } = await renderQuickActions({
          settings: { ...hold },
          pluginActions: [
            { key: "workstreams/snooze", action: snoozeAction() },
            { key: "thread-list/move", action: move },
          ],
        });
        await holdOptionAt(centre);
        // Six slots: Archive, Snooze, Move to section, Pin, Mark unread, Copy link.
        const toward = (deg: number, r: number) => ({
          clientX: centre.clientX + r * Math.sin((deg * Math.PI) / 180),
          clientY: centre.clientY - r * Math.cos((deg * Math.PI) / 180),
        });
        const bands = () => Array.from(document.querySelectorAll<SVGElement>(".qa-band"));
        expect(bands()).toHaveLength(2);
        expect(document.querySelectorAll(".qa-ring-more")).toHaveLength(2);
        expect(slot.getByRole("menu", { name: "Move to section" })).toBeInTheDocument();

        await pointAt(toward(120, 52));
        expect(item("Move to section")).toHaveAttribute("data-selected", "true");
        expect(bands().map((node) => node.getAttribute("data-extended"))).toEqual(["false", "true"]);

        await pointAt(toward(60, 52));
        expect(bands().map((node) => node.getAttribute("data-extended"))).toEqual(["true", "false"]);

        await pointAt(toward(120, 100));
        await pointAt(onBand("Later"));
        expect(item("Later")).toHaveAttribute("data-selected", "true");
        await releaseOption();
        expect(move.run).toHaveBeenCalledExactlyOnceWith("later");
        slot.lifecycle.unmount();
      });
    });

    describe("right-click", () => {
      const corner = { trigger: "corner" } as const;
      const at = { clientX: 400, clientY: 300 };

      /** Presses the secondary button on the timeline; true if the browser menu would show. */
      async function rightClick(
        target: Element = timeline,
        point: { clientX: number; clientY: number } = at,
      ) {
        let shown = true;
        await act(async () => {
          fireEvent.pointerDown(target, { ...point, button: 2 });
          shown = fireEvent.contextMenu(target, { ...point, button: 2 });
        });
        return shown;
      }

      async function releaseRight(point: { clientX: number; clientY: number }) {
        await act(async () => {
          fireEvent.pointerUp(timeline, { ...point, button: 2 });
        });
      }

      it("is on by default and opens the ring in place of the browser menu", async () => {
        const { slot } = await renderQuickActions({ settings: { ...corner } });
        expect(await rightClick()).toBe(false);
        expect(ring()?.style.left).toBe("400px");
        expect(ring()?.style.top).toBe("300px");
        expect(document.querySelector(".qa-dim")).toHaveAttribute("data-state", "on");
        // The corner trigger stays alongside it.
        expect(slot.getByRole("button", { name: "Open quick actions" })).toBeInTheDocument();
        slot.lifecycle.unmount();
      });

      it("runs what the button is released on", async () => {
        const { slot, runs } = await renderQuickActions({ settings: { ...corner } });
        await rightClick();
        await pointAt({ clientX: 400, clientY: 240 });
        await releaseRight({ clientX: 400, clientY: 240 });
        expect(runs.get("bb--core/archive")).toHaveBeenCalledOnce();
        slot.lifecycle.unmount();
      });

      it("stays open when released in the hub, then runs on a click of the disc", async () => {
        const { slot, runs } = await renderQuickActions({ settings: { ...corner } });
        await rightClick();
        await releaseRight(at);
        await advance(400);
        expect(ring()).not.toBeNull();
        for (const run of runs.values()) expect(run).not.toHaveBeenCalled();

        await pointAt({ clientX: 400, clientY: 240 });
        const base = document.querySelector<HTMLElement>(".qa-ring-base");
        await act(async () => {
          fireEvent.pointerDown(base!);
          fireEvent.click(base!);
        });
        expect(runs.get("bb--core/archive")).toHaveBeenCalledOnce();
        slot.lifecycle.unmount();
      });

      it("is not run by releasing Option", async () => {
        const { slot, runs } = await renderQuickActions({
          settings: { trigger: "hold-option" },
        });
        await rightClick();
        await releaseRight(at);
        await pointAt({ clientX: 400, clientY: 240 });
        await act(async () => {
          fireEvent.keyDown(window, { key: "Alt" });
        });
        await releaseOption();
        expect(runs.get("bb--core/archive")).not.toHaveBeenCalled();
        expect(ring()).not.toBeNull();
        slot.lifecycle.unmount();
      });

      it("keeps the browser menu on fields, links, and media, and outside a thread pane", async () => {
        const { slot } = await renderQuickActions({ settings: { ...corner } });
        for (const tag of ["textarea", "a", "img"]) {
          const element = document.createElement(tag);
          if (tag === "a") element.setAttribute("href", "https://example.com");
          timeline.append(element);
          expect(await rightClick(element)).toBe(true);
          element.remove();
        }
        expect(await rightClick(sidebar, { clientX: 120, clientY: 500 })).toBe(true);
        expect(ring()).toBeNull();
        slot.lifecycle.unmount();
      });

      it("keeps a menu something else already showed, and one from the keyboard", async () => {
        const { slot } = await renderQuickActions({ settings: { ...corner } });
        const ownMenu = (event: Event) => event.preventDefault();
        timeline.addEventListener("contextmenu", ownMenu);
        await rightClick();
        timeline.removeEventListener("contextmenu", ownMenu);
        expect(ring()).toBeNull();

        // A menu key press arrives with no pointer press before it.
        expect(fireEvent.contextMenu(timeline, at)).toBe(true);
        expect(ring()).toBeNull();
        slot.lifecycle.unmount();
      });

      it("keeps the browser menu on selected text, and puts back a selection the click made", async () => {
        const { slot } = await renderQuickActions({ settings: { ...corner } });
        const text = document.createElement("p");
        text.textContent = "flaky retry";
        timeline.append(text);
        // jsdom has no layout: the text occupies a box around the click.
        Object.defineProperty(Range.prototype, "getClientRects", {
          configurable: true,
          value: () => [{ left: 380, right: 420, top: 290, bottom: 310 }],
        });
        const selection = document.getSelection()!;
        selection.selectAllChildren(text);
        expect(await rightClick(text)).toBe(true);
        expect(ring()).toBeNull();

        // Unselected text: the browser selects a word as the button goes down.
        selection.removeAllRanges();
        let shown = true;
        await act(async () => {
          fireEvent.pointerDown(text, { ...at, button: 2 });
          selection.selectAllChildren(text);
          shown = fireEvent.contextMenu(text, { ...at, button: 2 });
        });
        expect(shown).toBe(false);
        expect(ring()).not.toBeNull();
        expect(selection.toString()).toBe("");
        Reflect.deleteProperty(Range.prototype, "getClientRects");
        text.remove();
        slot.lifecycle.unmount();
      });

      it("waits for an unfocused split pane to become the open thread", async () => {
        const { slot } = await renderQuickActions({ settings: { ...corner } });
        const pane = document.createElement("div");
        pane.setAttribute("data-split-pane-id", "pane_2");
        pane.setAttribute("data-focused", "false");
        threadWindow.replaceWith(pane);
        pane.append(threadWindow);
        expect(await rightClick()).toBe(false);
        expect(ring()).toBeNull();
        // The same thread in both panes: the ring opens after a short grace.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        });
        expect(ring()?.style.left).toBe("400px");
        pane.replaceWith(threadWindow);
        slot.lifecycle.unmount();
      });

      it("can be turned off", async () => {
        const { slot } = await renderQuickActions({
          settings: { trigger: "hold-option", rightClick: false },
        });
        expect(await rightClick()).toBe(true);
        expect(ring()).toBeNull();
        await holdOptionAt(at);
        expect(ring()).not.toBeNull();
        slot.lifecycle.unmount();
      });
    });

    it("runs the selection when the disc is clicked", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 240 });
      const base = document.querySelector<HTMLElement>(".qa-ring-base");
      await act(async () => {
        fireEvent.pointerDown(base!);
        fireEvent.click(base!);
      });
      expect(runs.get("bb--core/archive")).toHaveBeenCalledOnce();
      slot.lifecycle.unmount();
    });
  });
});
