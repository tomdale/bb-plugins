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

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

async function renderQuickActions({
  settings = { trigger: "corner", corner: "bottom-left", motion: "ring" },
  archivedAt = null,
  snoozeError = null,
  childCount = 0,
  snoozeWait = null,
  strictMode = false,
}: {
  settings?: Record<string, string | number | boolean>;
  archivedAt?: number | null;
  snoozeError?: Error | null;
  childCount?: number;
  snoozeWait?: Promise<void> | null;
  strictMode?: boolean;
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
  const thread = makeThreadResponse({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    archivedAt,
    lastReadAt: 0,
    latestAttentionAt: 0,
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
      sdk: {
        threads: {
          get: async () => thread,
          childSummary: async () => ({
            nonDeletedChildCount: childCount,
            unarchivedDescendantCount: childCount,
          }),
        },
      },
      threadActions: () => entries,
      rpc: {
        snooze: async () => {
          if (snoozeWait) await snoozeWait;
          if (snoozeError) throw snoozeError;
          return {
            threadId: THREAD_ID,
            wakeAt: Date.UTC(2026, 10, 10, 9),
          };
        },
      },
    },
  );
  await slot.findByRole("group", { name: "Quick actions" });
  const trigger = slot.queryByRole("button", {
    name: "Open quick actions",
  });
  return { slot, trigger: trigger as HTMLElement, runs };
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

  it("ignores a stale Snooze summary after navigation", async () => {
    const firstThread = makeThreadResponse({
      id: THREAD_ID,
      projectId: PROJECT_ID,
    });
    const secondThread = makeThreadResponse({
      id: "thr_second",
      projectId: PROJECT_ID,
    });
    type Summary = {
      nonDeletedChildCount: number;
      unarchivedDescendantCount: number;
    };
    let resolveSummary: ((summary: Summary) => void) | undefined;
    const summary = new Promise<Summary>((resolve) => {
      resolveSummary = resolve;
    });
    const snooze = vi.fn(async () => ({
      threadId: THREAD_ID,
      wakeAt: Date.UTC(2026, 10, 10, 9),
    }));
    const run = vi.fn(async () => undefined);
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
            childSummary: async () => summary,
          },
        },
        threadActions: () => [
          actionEntry("bb--core/archive", "Archive", run),
          actionEntry("bb--core/pin", "Pin", run),
          actionEntry("bb--core/read", "Mark unread", run),
          actionEntry("bb--core/copyLink", "Copy link", run),
        ],
        rpc: { snooze },
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Open quick actions",
    });
    await openMenu(trigger);
    const user = userEvent.setup();
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    await waitFor(() =>
      expect(
        slot.inspection.sdkCalls.some(
          (call) => call.method === "threads.childSummary",
        ),
      ).toBe(true),
    );

    slot.lifecycle.rerender(<QuickActionsOverlay threadId="thr_second" />);
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-disabled", "false"),
    );
    await act(async () => {
      resolveSummary?.({
        nonDeletedChildCount: 2,
        unarchivedDescendantCount: 2,
      });
      await summary;
    });

    expect(slot.queryByRole("alertdialog")).toBeNull();
    expect(snooze).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.querySelector(".qa-menu")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
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
    expect(document.querySelectorAll(".qa-hover-corridor")).toHaveLength(5);
    slot.lifecycle.unmount();
  });

  it("sanitizes each unknown stored setting", async () => {
    await renderQuickActions({
      settings: { trigger: "unknown", corner: "unknown", motion: "unknown" },
    });
    const menu = document.querySelector(".qa-menu");
    expect(menu).toHaveAttribute("data-corner", "bottom-left");
    expect(menu).toHaveAttribute("data-motion", "ring");
    expect(menu).toHaveAttribute("data-trigger", "hold-option");
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

  it("snoozes and navigates after StrictMode effect replay", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions({ strictMode: true });
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toCompose",
        options: { projectId: PROJECT_ID },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("snoozes the current thread and returns to New thread", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions();
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "snooze",
        input: { threadId: THREAD_ID },
      });
    });
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: { projectId: PROJECT_ID },
    });
    slot.lifecycle.unmount();
  });

  it("does not navigate after a late Snooze response unmounts the thread", async () => {
    const user = userEvent.setup();
    let finishSnooze: (() => void) | undefined;
    const snoozeWait = new Promise<void>((resolve) => {
      finishSnooze = resolve;
    });
    const { slot, trigger } = await renderQuickActions({ snoozeWait });
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "snooze",
        input: { threadId: THREAD_ID },
      }),
    );
    slot.lifecycle.unmount();
    finishSnooze?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.inspection.navigateCalls).not.toContainEqual({
      method: "toCompose",
      options: { projectId: PROJECT_ID },
    });
  });

  it("confirms before snoozing active descendants", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions({ childCount: 2 });
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    expect(await slot.findByRole("alertdialog")).toHaveTextContent(
      "Snooze 3 threads?",
    );
    expect(slot.inspection.rpcCalls).not.toContainEqual({
      method: "snooze",
      input: { threadId: THREAD_ID },
    });
    await user.click(slot.getByRole("button", { name: "Snooze 3 threads" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "snooze",
        input: { threadId: THREAD_ID },
      }),
    );
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: { projectId: PROJECT_ID },
    });
    slot.lifecycle.unmount();
  });

  it("restores a closed trigger when Snooze confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions({ childCount: 1 });
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    await user.click(await slot.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    slot.lifecycle.unmount();
  });

  it("reports Snooze failure without navigating", async () => {
    const user = userEvent.setup();
    const { slot, trigger } = await renderQuickActions({
      snoozeError: new Error("archive unavailable"),
    });
    await openMenu(trigger);
    await user.click(slot.getByRole("button", { name: "Snooze" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Snooze failed: archive unavailable",
      ),
    );
    expect(slot.inspection.navigateCalls).not.toContainEqual({
      method: "toCompose",
      options: { projectId: PROJECT_ID },
    });
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

  describe("hold Option at the pointer", () => {
    const hold = { trigger: "hold-option" } as const;

    async function holdOptionAt(
      point: { clientX: number; clientY: number },
      waitMs = 260,
    ) {
      fireEvent.pointerMove(window, point);
      await act(async () => {
        fireEvent.keyDown(window, { key: "Alt" });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      });
    }

    it("renders no corner trigger and opens at the pointer after a hold", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      expect(menu).toHaveAttribute("data-trigger", "hold-option");
      expect(
        slot.queryByRole("button", { name: "Open quick actions" }),
      ).toBeNull();
      expect(document.querySelector(".qa-hover-core")).toBeNull();
      expect(document.querySelectorAll(".qa-hover-corridor")).toHaveLength(0);

      await holdOptionAt({ clientX: 400, clientY: 300 });

      expect(menu).toHaveAttribute("data-open", "true");
      expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("378px");
      expect(menu?.style.getPropertyValue("--qa-menu-y")).toBe("278px");
      slot.lifecycle.unmount();
    });

    it("ignores a quick tap of Option", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      fireEvent.pointerMove(window, { clientX: 400, clientY: 300 });
      await act(async () => {
        fireEvent.keyDown(window, { key: "Alt" });
      });
      await act(async () => {
        fireEvent.keyUp(window, { key: "Alt" });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 260));
      });
      expect(menu).toHaveAttribute("data-open", "false");
      slot.lifecycle.unmount();
    });

    async function releaseOption() {
      await act(async () => {
        fireEvent.keyUp(window, { key: "Alt" });
      });
    }

    async function pointAt(point: { clientX: number; clientY: number }) {
      await act(async () => {
        fireEvent.pointerMove(window, point);
      });
    }

    it("centres the pie exactly on the pointer, even at the window edge", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      await holdOptionAt({ clientX: 4, clientY: 6 });
      expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("-18px");
      expect(menu?.style.getPropertyValue("--qa-menu-y")).toBe("-16px");
      slot.lifecycle.unmount();
    });

    it("takes the centre from where the pointer is when the hold completes", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
      await act(async () => {
        fireEvent.keyDown(window, { key: "Alt" });
      });
      fireEvent.pointerMove(window, { clientX: 500, clientY: 400 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 260));
      });
      expect(menu?.style.getPropertyValue("--qa-menu-x")).toBe("478px");
      expect(menu?.style.getPropertyValue("--qa-menu-y")).toBe("378px");
      slot.lifecycle.unmount();
    });

    it("selects nothing while the pointer is in the hub", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 280 });
      expect(menu).toHaveAttribute("data-in-hub", "true");
      expect(document.querySelectorAll('.qa-pie-slice[data-lit="true"]')).toHaveLength(0);
      slot.lifecycle.unmount();
    });

    it("closes without running when Option is released in the hub", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await releaseOption();
      expect(menu).toHaveAttribute("data-open", "false");
      expect(menu).toHaveAttribute("data-close", "cancel");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(runs.get("bb--core/archive")).not.toHaveBeenCalled();
      slot.lifecycle.unmount();
    });

    it("runs the selected slice when Option is released outside the hub", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 240 });
      await releaseOption();
      // The chosen slice brightens for a beat before the pie closes.
      expect(menu).toHaveAttribute("data-confirming", "true");
      expect(menu).toHaveAttribute("data-open", "true");
      await waitFor(() => expect(runs.get("bb--core/archive")).toHaveBeenCalledOnce());
      expect(menu).toHaveAttribute("data-open", "false");
      expect(menu).toHaveAttribute("data-close", "run");
      slot.lifecycle.unmount();
    });

    it("cancels with Escape", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 240 });
      await act(async () => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      expect(menu).toHaveAttribute("data-open", "false");
      expect(menu).toHaveAttribute("data-instant", "false");
      await releaseOption();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(runs.get("bb--core/archive")).not.toHaveBeenCalled();
      slot.lifecycle.unmount();
    });

    it("gets out of the way without animating when the user types", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await act(async () => {
        fireEvent.keyDown(window, { key: "Shift" });
      });
      expect(menu).toHaveAttribute("data-open", "true");
      await act(async () => {
        fireEvent.keyDown(window, { key: "e" });
      });
      expect(menu).toHaveAttribute("data-open", "false");
      expect(menu).toHaveAttribute("data-instant", "true");
      slot.lifecycle.unmount();
    });

    it("labels every slice and lights the one the pointer points into", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      const archive = slot.getByRole("button", { name: "Archive" });
      expect(archive).toHaveTextContent("Archive");
      const slices = document.querySelectorAll(".qa-pie-slice");
      expect(slices).toHaveLength(5);
      expect(slices[0]).toHaveAttribute("data-lit", "false");

      await pointAt({ clientX: 400, clientY: 220 });
      expect(slices[0]).toHaveAttribute("data-lit", "true");
      expect(archive).toHaveAttribute("data-selected", "true");
      slot.lifecycle.unmount();
    });

    it("runs the lit slice when the pie is clicked", async () => {
      const { slot, runs } = await renderQuickActions({ settings: { ...hold } });
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await pointAt({ clientX: 400, clientY: 250 });
      const pie = document.querySelector<HTMLElement>(".qa-pie");
      await act(async () => {
        fireEvent.pointerDown(pie!);
      });
      expect(document.querySelector(".qa-menu")).toHaveAttribute("data-pressed", "true");
      await act(async () => {
        fireEvent.pointerUp(pie!);
        fireEvent.click(pie!);
      });
      await waitFor(() => expect(runs.get("bb--core/archive")).toHaveBeenCalledOnce());
      slot.lifecycle.unmount();
    });

    it("cancels when the user presses outside the pie", async () => {
      const { slot } = await renderQuickActions({ settings: { ...hold } });
      const menu = document.querySelector<HTMLElement>(".qa-menu");
      await holdOptionAt({ clientX: 400, clientY: 300 });
      await act(async () => {
        fireEvent.pointerDown(document.body);
      });
      expect(menu).toHaveAttribute("data-open", "false");
      slot.lifecycle.unmount();
    });
  });
});
