// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Walkthrough } from "../src/schemas.ts";
import { pageRoutePath } from "../src/ui/popout.ts";
import { walkthroughIdFromSubPath } from "../src/ui/Window.tsx";

const PLUGIN_ID = "bb-plugin-walkthrough";

function walkthrough(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    id: "wt_1",
    threadId: "thr_1",
    workerThreadId: "thr_w",
    request: "Walk me through it",
    status: "reading",
    message: null,
    title: "Branch feature",
    mode: "local",
    baseRef: "origin/main",
    includeUncommitted: true,
    pr: null,
    introduction: "",
    parts: [
      {
        title: "Schema",
        summary: "",
        locations: [],
        status: "ready",
        blocks: [{ kind: "prose", text: "The schema comes first." }],
        suggestions: [],
        message: null,
        discussion: [],
      },
    ],
    currentPart: 0,
    wrapUp: null,
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/w",
    notesFile: { enabled: false, path: null, written: false, error: null },
    review: null,
    queue: [],
    inFlight: null,
    nextNoteNumber: 1,
    nextExchangeNumber: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const mounted: Array<{ lifecycle: { unmount: () => void } }> = [];
const open = vi.fn();
beforeEach(() => {
  open.mockReset();
  vi.stubGlobal("open", open);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  vi.unstubAllGlobals();
});

async function mountPanel() {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: { walkthroughId: "wt_1" } }, {
    pluginId: PLUGIN_ID,
    rpc: { get: () => ({ view: { walkthrough: walkthrough(), notes: [] } }) },
  });
  mounted.push(slot);
  return slot;
}

async function mountPage(subPath: string, rpc: Record<string, () => unknown>) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const registration = app.navPanels.find((panel) => panel.path === "walkthroughs")!;
  const slot = renderSlot(registration, { subPath }, { pluginId: PLUGIN_ID, rpc: rpc as never });
  mounted.push(slot);
  return slot;
}

describe("pop-out window", () => {
  it("routes the walkthrough id through the nav panel's sub-path", () => {
    expect(pageRoutePath(PLUGIN_ID, "wt_1")).toBe("/plugins/bb-plugin-walkthrough/walkthroughs/wt_1");
    expect(pageRoutePath("a b", "x/y")).toBe("/plugins/a%20b/walkthroughs/x%2Fy");
    expect(walkthroughIdFromSubPath("")).toBeNull();
    expect(walkthroughIdFromSubPath("wt_1")).toBe("wt_1");
    expect(walkthroughIdFromSubPath("/wt_1/")).toBe("wt_1");
  });

  it("opens the panel's walkthrough in a popup window, then refocuses it", async () => {
    const popup = { closed: false, focus: vi.fn() };
    open.mockReturnValue(popup);
    const slot = await mountPanel();
    const button = await slot.findByRole("button", { name: "Open in a new window" });
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/plugins/${PLUGIN_ID}/walkthroughs/wt_1`, `${PLUGIN_ID}:wt_1`, expect.stringContaining("popup"));
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalledTimes(1);
    popup.closed = true;
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens the page again when the host gives no window handle", async () => {
    open.mockReturnValue(null);
    const slot = await mountPanel();
    const button = await slot.findByRole("button", { name: "Open in a new window" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("shows the walkthrough on its own page without panel-only controls", async () => {
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: walkthrough(), notes: [] } }) });
    await slot.findByText("The schema comes first.");
    expect(slot.queryByRole("button", { name: "Open in a new window" })).toBeNull();
    expect(slot.inspection.rpcCalls.map((call) => call.input)).toContainEqual({ walkthroughId: "wt_1" });
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("says when the walkthrough no longer exists", async () => {
    const slot = await mountPage("wt_gone", { get: () => ({ view: null }) });
    await slot.findByText("This walkthrough no longer exists.");
  });

  it("lists recent walkthroughs at the root and opens one as a page", async () => {
    const summary = { id: "wt_1", title: "Branch feature", request: "r", status: "reading", partCount: 3, currentPart: 0, openNotes: 0, createdAt: 1 };
    const slot = await mountPage("", { recent: () => ({ walkthroughs: [summary, { ...summary, id: "wt_2", title: "Walkthrough", request: "The PR", status: "done" }] }) });
    fireEvent.click(await slot.findByRole("button", { name: /The PR/ }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "walkthroughs", options: { subPath: "wt_2" } }]);
  });
});
