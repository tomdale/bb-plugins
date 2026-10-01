// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Run } from "./src/contracts.ts";
const run: Run = {
  id: "run", ownerThreadId: "origin", rootThreadId: "origin", threadId: "worker", title: "Review", task: "Review code", depth: 1,
  createdAt: 1, deadline: null, status: "running", control: "agent", output: "", error: null, notifications: [], cleanupPending: false,
};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
it("shows a composer-free transcript and promotes before navigating", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "origin", params: null }, { rpc: {
    list: () => ({ runs: [run], promoted: null }), promote: () => ({ threadId: "worker" }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
  await slot.findByText("Background agents share this workspace. Transcripts are read-only here.");
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(slot.inspection.rpcCalls.some(call => call.method === "promote")).toBe(true);
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("worker");
  expect(slot.queryByRole("textbox")).toBeNull();
});
it("offers Return control only in user-controlled workers", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "worker", projectId: "project", isCompactViewport: false }, { rpc: {
    list: () => ({ runs: [], promoted: { ...run, control: "user" } }), returnControl: () => ({ threadId: "origin" }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByRole("button", { name: "Return control to original thread" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(slot.inspection.rpcCalls.some(call => call.method === "returnControl")).toBe(true);
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("origin");
});
