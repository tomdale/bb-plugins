// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { ComponentType } from "react";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalThreadTabProps, JsonValue } from "@get-bb/plugin-sdk/app";
import type { Run } from "./contracts.ts";

/** The action-variant component of the registered tab, narrowed for renderSlot. */
function tabComponent(app: Awaited<ReturnType<typeof loadPluginApp>>) {
  return app.tabs[0] as unknown as {
    component: ComponentType<ExperimentalThreadTabProps & { params: JsonValue | null }>;
  };
}

const baseRun: Run = {
  id: "run",
  ownerThreadId: "origin",
  rootThreadId: "origin",
  threadId: "worker",
  title: "Audit CSRF middleware",
  task: "Inspect POST/PUT/DELETE handlers under src/server.",
  depth: 1,
  providerId: "pi",
  model: "claude-opus-4-6",
  reasoningLevel: "high",
  statusSummary: "Verified 12 of 14 mutating API routes.",
  summaryUpdatedAt: 1,
  createdAt: 1,
  deadline: null,
  status: "running",
  control: "agent",
  output: "",
  error: null,
  notifications: [],
  cleanupPending: false,
};

function makeRun(overrides: Partial<Run> = {}): Run {
  return { ...baseRun, createdAt: Date.now(), ...overrides };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("opens on the Active then Inactive list view with status summaries, execution chips, and tree hierarchy without depth numbers", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const now = Date.now();
  const slot = renderSlot(
    tabComponent(app),
    { threadId: "origin", environment: null, params: null },
    {
      rpc: {
        list: () => ({
          runs: [
            makeRun({
              id: "parent",
              title: "Audit CSRF middleware",
              threadId: "parent-thread",
              status: "running",
              providerId: "pi",
              model: "claude-opus-4-6",
              reasoningLevel: "high",
              statusSummary: "Verified 12 of 14 mutating API routes.",
              createdAt: now - 60_000,
            }),
            makeRun({
              id: "child-done",
              ownerThreadId: "parent-thread",
              title: "List unguarded webhook routes",
              threadId: "child-done-thread",
              depth: 2,
              status: "completed",
              providerId: "pi",
              model: "claude-haiku-4-5",
              reasoningLevel: "low",
              statusSummary: "Confirmed both webhook endpoints verify HMAC signatures.",
              createdAt: now - 50_000,
            }),
            makeRun({
              id: "settled",
              title: "Run legacy cookie suite",
              threadId: "settled-thread",
              status: "timed-out",
              providerId: "codex",
              model: "gpt-5.4",
              reasoningLevel: "medium",
              statusSummary: "Stalled waiting for the Vitest port lock.",
              error: "Subagent timeout exceeded (600s).",
              createdAt: now - 12 * 60_000,
            }),
          ],
        }),
      },
    },
  );
  cleanups.push(() => slot.lifecycle.unmount());

  const activeGroup = await slot.findByRole("group", { name: "Active subagents" });
  const inactiveGroup = await slot.findByRole("group", { name: "Inactive subagents" });
  expect(activeGroup.textContent).toContain("Audit CSRF middleware");
  // Option A: settled child of an active parent stays nested in the active subtree
  expect(activeGroup.textContent).toContain("List unguarded webhook routes");
  expect(inactiveGroup.textContent).toContain("Run legacy cookie suite");

  // Status summaries and provider/model/thinking specs render on rows
  expect(slot.getByText("Verified 12 of 14 mutating API routes.")).toBeTruthy();
  expect(slot.getByText("Confirmed both webhook endpoints verify HMAC signatures.")).toBeTruthy();
  expect(slot.getAllByText("Pi").length).toBeGreaterThanOrEqual(2);
  expect(slot.getByText("Codex")).toBeTruthy();
  expect(slot.getByText("claude-opus-4-6")).toBeTruthy();
  expect(slot.getByText("gpt-5.4")).toBeTruthy();
  expect(slot.getByText("thinking: high")).toBeTruthy();
  expect(slot.getByText("thinking: low")).toBeTruthy();
  expect(slot.getByText("thinking: medium")).toBeTruthy();

  // Never renders numeric depth labels
  expect(slot.queryByText(/depth\s+\d/i)).toBeNull();
  // Initial view is the list, not the transcript
  expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
});

it("drills into a subagent's detail view, navigates parent/child links, and detaches into a child thread", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const now = Date.now();
  const slot = renderSlot(
    tabComponent(app),
    { threadId: "origin", environment: null, params: null },
    {
      rpc: {
        list: () => ({
          runs: [
            makeRun({
              id: "parent",
              title: "Audit CSRF middleware",
              threadId: "parent-thread",
              status: "running",
              createdAt: now - 60_000,
            }),
            makeRun({
              id: "child",
              ownerThreadId: "parent-thread",
              title: "Check OAuth callback state",
              threadId: "child-thread",
              depth: 2,
              status: "running",
              statusSummary: "Tracing signed state cookie verification.",
              createdAt: now - 38_000,
            }),
          ],
        }),
        detach: () => ({ threadId: "parent-thread" }),
      },
    },
  );
  cleanups.push(() => slot.lifecycle.unmount());

  // Click child row to open its detail view
  fireEvent.click(await slot.findByRole("button", { name: /Check OAuth callback state/ }));
  expect((await slot.findByTestId("bb-thread-chat")).getAttribute("data-thread-id")).toBe("child-thread");
  expect(slot.getByText("Tracing signed state cookie verification.")).toBeTruthy();

  // Click parent breadcrumb link in the detail header to jump to parent
  fireEvent.click(slot.getByRole("button", { name: "Parent subagent: Audit CSRF middleware" }));
  expect((await slot.findByTestId("bb-thread-chat")).getAttribute("data-thread-id")).toBe("parent-thread");
  expect(slot.getByRole("group", { name: "Spawned subagents" }).textContent).toContain("Check OAuth callback state");

  // Click Detach subagent
  fireEvent.click(slot.getByRole("button", { name: "Detach subagent" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(slot.inspection.rpcCalls.some(call => call.method === "detach")).toBe(true);
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("parent-thread");

  // Click ← Subagents to return to the list
  fireEvent.click(slot.getByRole("button", { name: "← Subagents" }));
  expect(await slot.findByRole("group", { name: "Active subagents" })).toBeTruthy();
});

it("disables Detach subagent while a run is still starting and shows error alerts on failed runs", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    tabComponent(app),
    { threadId: "origin", environment: null, params: null },
    {
      rpc: {
        list: () => ({
          runs: [
            makeRun({
              id: "starting-run",
              title: "Verify rate-limiter fallback",
              threadId: null,
              status: "starting",
            }),
            makeRun({
              id: "failed-run",
              title: "Run legacy cookie suite",
              threadId: "failed-thread",
              status: "timed-out",
              error: "Subagent timeout exceeded (600s).",
            }),
          ],
        }),
      },
    },
  );
  cleanups.push(() => slot.lifecycle.unmount());

  fireEvent.click(await slot.findByRole("button", { name: /Verify rate-limiter fallback/ }));
  expect((await slot.findByRole("button", { name: "Detach subagent" })).hasAttribute("disabled")).toBe(true);
  expect(slot.getByRole("status").textContent).toContain("Starting worker thread…");

  fireEvent.click(slot.getByRole("button", { name: "← Subagents" }));
  fireEvent.click(await slot.findByRole("button", { name: /Run legacy cookie suite/ }));
  expect((await slot.findByRole("alert")).textContent).toBe("Subagent timeout exceeded (600s).");
});
