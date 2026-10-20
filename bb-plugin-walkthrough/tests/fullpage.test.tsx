// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Walkthrough } from "../src/schemas.ts";
import { walkthroughIdFromSubPath } from "../src/ui/FullPage.tsx";

const PLUGIN_ID = "walkthrough";

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
beforeEach(() => {
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

describe("full page", () => {
  it("reads the walkthrough id from the nav panel's sub-path", () => {
    expect(walkthroughIdFromSubPath("")).toBeNull();
    expect(walkthroughIdFromSubPath("wt_1")).toBe("wt_1");
    expect(walkthroughIdFromSubPath("/wt_1/")).toBe("wt_1");
  });

  it("expands the panel's walkthrough into the full page", async () => {
    const slot = await mountPanel();
    fireEvent.click(await slot.findByRole("button", { name: "Open as a full page" }));
    // The panel first retitles its own tab; the click then navigates.
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "walkthroughs", options: { subPath: "wt_1" } });
  });

  it("shows the walkthrough on its own page, with a way back to its thread", async () => {
    const slot = await mountPage("wt_1", { get: () => ({ view: { walkthrough: walkthrough(), notes: [] } }) });
    await slot.findByText("The schema comes first.");
    expect(slot.queryByRole("button", { name: "Open as a full page" })).toBeNull();
    expect(slot.inspection.rpcCalls.map((call) => call.input)).toContainEqual({ walkthroughId: "wt_1" });
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_1" }]);
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
