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
const THREAD_ID = "thr_test";
const PROJECT_ID = "proj_test";
let now = 0;
let nextFrame = 1;
let frames = new Map<number, FrameRequestCallback>();
let resizeObserverCallback: (() => void) | null = null;

beforeEach(() => {
  now = 0;
  nextFrame = 1;
  frames = new Map();
  resizeObserverCallback = null;
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
      disconnect() {}
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
  settings = { corner: "bottom-left", motion: "ring" },
  archivedAt = null,
  snoozeError = null,
  childCount = 0,
  snoozeWait = null,
  strictMode = false,
}: {
  settings?: Record<string, string>;
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
  const trigger = await slot.findByRole("button", {
    name: "Open quick actions",
  });
  return { slot, trigger, runs };
}

async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerEnter(trigger);
  await advance();
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

  it("uses configured motion and corner", async () => {
    const { slot } = await renderQuickActions({
      settings: { corner: "top-right", motion: "arc" },
    });
    const menu = document.querySelector(".qa-menu");
    expect(menu).toHaveAttribute("data-corner", "top-right");
    expect(menu).toHaveAttribute("data-motion", "arc");
    slot.lifecycle.unmount();
  });

  it("sanitizes each unknown stored setting", async () => {
    await renderQuickActions({
      settings: { corner: "unknown", motion: "unknown" },
    });
    const menu = document.querySelector(".qa-menu");
    expect(menu).toHaveAttribute("data-corner", "bottom-left");
    expect(menu).toHaveAttribute("data-motion", "ring");
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
    expect(menu?.style.left).toBe("336px");
    expect(menu?.style.top).toBe("457px");
    footerRect.left = 400;
    footerRect.top = 567;
    await act(async () => resizeObserverCallback?.());
    expect(menu?.style.left).toBe("416px");
    expect(menu?.style.top).toBe("507px");
    slot.lifecycle.unmount();
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
});
