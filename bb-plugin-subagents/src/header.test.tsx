// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { ComponentType } from "react";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TooltipProvider } from "../components/ui/tooltip.js";
import type { Run } from "./contracts.ts";
const run: Run = {
  id: "run", ownerThreadId: "origin", rootThreadId: "origin", threadId: "worker", title: "Review", task: "Review code", depth: 1,
  createdAt: 1, deadline: null, status: "running", control: "agent", output: "", error: null, notifications: [], cleanupPending: false,
};
// BB's AppLayout mounts one TooltipProvider around the app; the standalone
// test slot has none, so mirror the production tree here.
function insideTooltipProvider<P extends object>(Component: ComponentType<P>): ComponentType<P> {
  return function TooltipProviderWrapped(props: P) {
    return <TooltipProvider><Component {...props} /></TooltipProvider>;
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
it("offers Return control only in user-controlled workers", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot({ component: insideTooltipProvider(app.threadHeaderActions[0]!.component) }, { threadId: "worker", projectId: "project", isCompactViewport: false }, { rpc: {
    list: () => ({ runs: [], promoted: { ...run, control: "user" } }), returnControl: () => ({ threadId: "origin" }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByRole("button", { name: "Return control to original thread" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(slot.inspection.rpcCalls.some(call => call.method === "returnControl")).toBe(true);
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("origin");
});
it("hides the badge when every run is settled", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot({ component: insideTooltipProvider(app.threadHeaderActions[0]!.component) }, { threadId: "origin", projectId: "project", isCompactViewport: false }, { rpc: {
    list: () => ({ runs: [
      { ...run, status: "completed" },
      { ...run, id: "run-failed", status: "failed" },
      { ...run, id: "run-killed", status: "killed" },
    ], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(slot.queryByRole("button")).toBeNull();
});
it("shows the working count with a pulsing Bot icon and opens the panel", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot({ component: insideTooltipProvider(app.threadHeaderActions[0]!.component) }, { threadId: "origin", projectId: "project", isCompactViewport: false }, { rpc: {
    list: () => ({ runs: [run, { ...run, id: "run-2" }, { ...run, id: "run-3", status: "completed" }], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  const badge = await slot.findByRole("button", { name: "Subagents: 2 running · 1 completed" });
  expect(badge.textContent).toBe("2");
  expect(badge.querySelector('[data-icon="Bot"]')?.className).toContain("animate-pulse");
  fireEvent.click(badge);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(slot.inspection.navigateCalls.some(call => call.method === "openThreadPanel"
    && call.options.actionId === "subagents" && call.options.title === "Subagents")).toBe(true);
});
it("shows user-controlled runs as a distinct badge beside the working one", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot({ component: insideTooltipProvider(app.threadHeaderActions[0]!.component) }, { threadId: "origin", projectId: "project", isCompactViewport: false }, { rpc: {
    list: () => ({ runs: [
      run,
      { ...run, id: "run-user", control: "user" },
      { ...run, id: "run-done", status: "completed" },
    ], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  const userBadge = await slot.findByRole("button", { name: "User-controlled subagents: 1 running · 1 user-controlled · 1 completed" });
  expect(userBadge.textContent).toBe("1");
  expect(userBadge.querySelector('[data-icon="UserRound"]')).not.toBeNull();
  expect(userBadge.className).toContain("border");
  const workingBadge = slot.getByRole("button", { name: "Subagents: 1 running · 1 user-controlled · 1 completed" });
  expect(workingBadge.textContent).toBe("1");
  expect(workingBadge.querySelector('[data-icon="Bot"]')?.className).toContain("animate-pulse");
});
it("keeps the user-controlled badge when nothing is working", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot({ component: insideTooltipProvider(app.threadHeaderActions[0]!.component) }, { threadId: "origin", projectId: "project", isCompactViewport: false }, { rpc: {
    list: () => ({ runs: [{ ...run, id: "run-user", control: "user" }], promoted: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  const userBadge = await slot.findByRole("button", { name: "User-controlled subagents: 1 user-controlled" });
  expect(slot.queryByRole("button", { name: /^Subagents: / })).toBeNull();
  expect(userBadge.querySelector('[data-icon="Bot"]')).toBeNull();
});
