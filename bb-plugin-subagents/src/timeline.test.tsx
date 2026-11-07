// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { RUN_DIRECTIVE_ID } from "./directive.ts";
import type { Run } from "./contracts.ts";
const run: Run = {
  id: "run", ownerThreadId: "origin", rootThreadId: "origin", threadId: "worker", title: "Review", task: "Review code", depth: 1,
  createdAt: 1, deadline: null, status: "running", control: "agent", output: "", error: null, notifications: [], cleanupPending: false,
};
function directiveProps(attributes: Record<string, string>): PluginMessageDirectiveProps {
  return {
    attributes,
    source: `::${RUN_DIRECTIVE_ID}{}`,
    message: { id: "message", threadId: "origin", turnId: null, projectId: null },
    openWorkspaceFile: null,
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function renderDirective(attributes: Record<string, string>, list: () => { runs: Run[]; promoted: Run | null }) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.messageDirectives[0]!, directiveProps(attributes), { rpc: { list } });
  cleanups.push(() => slot.lifecycle.unmount());
  return { slot, registrationId: app.messageDirectives[0]!.id };
}
it("renders the live run status in preference to the stale directive attributes", async () => {
  const { slot, registrationId } = await renderDirective({ id: "run", status: "completed", title: "Stale title" }, () => ({ runs: [run], promoted: null }));
  expect(registrationId).toBe(RUN_DIRECTIVE_ID);
  const badge = await slot.findByText("Running");
  expect(badge.className).toContain("text-success");
  expect(slot.getByText("Review")).toBeTruthy();
  expect(slot.queryByText("Stale title")).toBeNull();
  expect(slot.queryByRole("button", { name: "Open thread" })).toBeNull();
});
it("falls back to the directive attributes once the run is no longer listed", async () => {
  const slot = (await renderDirective({ id: "gone", status: "completed", title: "Old run" }, () => ({ runs: [run], promoted: null }))).slot;
  const badge = await slot.findByText("completed");
  expect(badge.className).toContain("text-muted-foreground");
  expect(slot.getByText("Old run")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Open thread" })).toBeNull();
});
it("renders nothing without a valid id", async () => {
  const slot = (await renderDirective({ title: "No id" }, () => ({ runs: [run], promoted: null }))).slot;
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(slot.container.textContent).toBe("");
});
it("offers Open thread only for a user-controlled run", async () => {
  const slot = (await renderDirective({ id: "run", status: "running", title: "Stale title" }, () => ({ runs: [{ ...run, control: "user" }], promoted: null }))).slot;
  expect((await slot.findByText("User controlled")).className).toContain("text-attention");
  fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("worker");
});
