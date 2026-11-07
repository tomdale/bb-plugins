// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Run } from "./contracts.ts";
const run: Run = {
  id: "run", ownerThreadId: "origin", rootThreadId: "origin", threadId: "worker", title: "Review", task: "Review code", depth: 1,
  createdAt: 1, deadline: null, status: "running", control: "agent", output: "", error: null, notifications: [], cleanupPending: false,
};
function makeRun(overrides: Partial<Run> = {}): Run {
  return { ...run, createdAt: Date.now(), ...overrides };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
it("shows a composer-free transcript and promotes before navigating", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
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
it("summarizes the runs in one count line", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const now = Date.now();
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "origin", params: null }, { rpc: {
    list: () => ({ runs: [
      makeRun({ id: "a", status: "running", createdAt: now - 5 * 60_000 }),
      makeRun({ id: "b", status: "starting", createdAt: now - 12 * 60_000 }),
      makeRun({ id: "c", status: "completed", control: "user", createdAt: now - 60 * 60_000 }),
      makeRun({ id: "d", status: "completed", createdAt: now - 3 * 60 * 60_000 }),
      makeRun({ id: "e", status: "failed", createdAt: now - 5 * 60 * 60_000 }),
    ], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByText("2 running · 1 user-controlled · 1 failed · 1 completed");
});
it("lists rows with status badges, depth, and age", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const now = Date.now();
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "origin", params: null }, { rpc: {
    list: () => ({ runs: [
      makeRun({ id: "nested", title: "Nested review", depth: 2, status: "failed", threadId: "nested-thread", createdAt: now - 12 * 60_000 }),
      makeRun({ id: "top", title: "Top review", depth: 1, status: "running", control: "user", threadId: "top-thread", createdAt: now - 2 * 60 * 60_000 }),
    ], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: /Nested review/ });
  expect(slot.getByRole("button", { name: /Nested review/ }).getAttribute("aria-pressed")).toBe("false");
  expect(slot.getByRole("button", { name: /Top review/ }).getAttribute("aria-pressed")).toBe("true");
  expect(slot.getByText("Failed").className).toContain("bg-destructive");
  expect(slot.getByText("User controlled")).toBeTruthy();
  expect(slot.getByText("depth 2")).toBeTruthy();
  expect(slot.queryByText("depth 1")).toBeNull();
  expect(slot.getByText("12m")).toBeTruthy();
  expect(slot.getByText("2h")).toBeTruthy();
});
it("auto-selects the newest working run", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const now = Date.now();
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "origin", params: null }, { rpc: {
    list: () => ({ runs: [
      makeRun({ id: "old-done", title: "Old done", status: "completed", threadId: "old-done-thread", createdAt: now - 60 * 60_000 }),
      makeRun({ id: "work-old", title: "Older worker", status: "running", threadId: "work-old-thread", createdAt: now - 10 * 60_000 }),
      makeRun({ id: "work-new", title: "Newer worker", status: "running", threadId: "work-new-thread", createdAt: now - 2 * 60_000 }),
    ], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  const chat = await slot.findByTestId("bb-thread-chat");
  expect(chat.getAttribute("data-thread-id")).toBe("work-new-thread");
  expect(slot.getByRole("button", { name: /Newer worker/ }).getAttribute("aria-pressed")).toBe("true");
  expect(slot.getByRole("button", { name: /Old done/ }).getAttribute("aria-pressed")).toBe("false");
});
it("keeps a clicked row selected across refreshes", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const now = Date.now();
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "origin", params: null }, { rpc: {
    list: () => ({ runs: [
      makeRun({ id: "work-old", title: "Older worker", status: "running", threadId: "work-old-thread", createdAt: now - 10 * 60_000 }),
      makeRun({ id: "work-new", title: "Newer worker", status: "running", threadId: "work-new-thread", createdAt: now - 2 * 60_000 }),
    ], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByTestId("bb-thread-chat");
  fireEvent.click(slot.getByRole("button", { name: /Older worker/ }));
  expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("work-old-thread");
  expect(slot.getByRole("button", { name: /Older worker/ }).getAttribute("aria-pressed")).toBe("true");
  expect(slot.getByRole("button", { name: /Newer worker/ }).getAttribute("aria-pressed")).toBe("false");
  await slot.behavior.emitRealtime("changed", {});
  await slot.findByTestId("bb-thread-chat");
  expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("work-old-thread");
});
it("shows no working emphasis when every run has settled", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const now = Date.now();
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "origin", params: null }, { rpc: {
    list: () => ({ runs: [
      makeRun({ id: "done-old", title: "Older done", status: "completed", threadId: "done-old-thread", createdAt: now - 60 * 60_000 }),
      makeRun({ id: "done-new", title: "Newer done", status: "completed", threadId: "done-new-thread", createdAt: now - 5 * 60_000 }),
    ], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByText("2 completed");
  expect(slot.queryByText("Running")).toBeNull();
  expect(slot.queryByText("Starting")).toBeNull();
  expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("done-new-thread");
});
