// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it } from "vitest";

const subject = "Plan the release";
const idleSnapshot = () => ({ tasks: [{ id: 1, subject, status: "pending" as const }], nextId: 2 });
afterEach(cleanup);

async function mount(snapshot: () => unknown = idleSnapshot, settings: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("./app.js"));
  const banner = app.composerCustomizations[0]!.banners![0]!;
  return renderSlot(banner, {}, {
    composer: { scope: { kind: "thread", threadId: "thread-a" } },
    rpc: { snapshot },
    settings,
  });
}

it("hides a completed card after the configured delay and shows it again when tasks change", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.05 });
  await slot.findByText(subject);
  await waitFor(() => expect(slot.queryByText(subject)).toBeNull());
  current = { tasks: [{ id: 1, subject, status: "completed" as const }, { id: 2, subject: "Next task", status: "pending" as const }], nextId: 3 };
  await slot.behavior.emitRealtime("todo-timeline-changed", { threadId: "thread-a" });
  await slot.findByText("Next task");
  slot.lifecycle.unmount();
});

it("restarts the completion delay after another completed-list mutation", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.15 });
  await slot.findByText(subject);
  await new Promise(resolve => setTimeout(resolve, 90));
  current = { tasks: [{ id: 1, subject: "Updated completed task", status: "completed" as const }], nextId: 2 };
  await slot.behavior.emitRealtime("todo-timeline-changed", { threadId: "thread-a" });
  await slot.findByText("Updated completed task");
  await new Promise(resolve => setTimeout(resolve, 90));
  expect(slot.getByText("Updated completed task")).toBeTruthy();
  await waitFor(() => expect(slot.queryByText("Updated completed task")).toBeNull());
  slot.lifecycle.unmount();
});
