// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { AccessSettings } from "./access-settings.js";

const app = await loadPluginApp(async () => ({ default: definePluginApp(app => {
  app.slots.settingsSection({ id: "access", component: AccessSettings });
}) }));
afterEach(cleanup);
const initial = { available: true, ready: false, message: "Not ready", key: null, phase: null, expiresAt: null, selected: false, defaultProvider: "direct", canRestore: false };
function render(rpc: Record<string, (input: never) => unknown> = {}) {
  return renderSlot(app.settingsSections[0]!, {}, { rpc: { "access.status": () => initial, ...rpc } as never });
}
it("reads without allocation and requires consent before preparation", async () => {
  const slot = render({ "access.prepare": () => ({ ...initial, key: "saved-key", phase: "ready" }) });
  const prepare = await slot.findByRole("button", { name: "Prepare tunnel" });
  await slot.findByText("Not ready");
  expect((prepare as HTMLButtonElement).disabled).toBe(true);
  expect(slot.inspection.rpcCalls.map(call => call.method)).toEqual(["access.status"]);
  fireEvent.click(slot.getByRole("checkbox", { name: /I approve one paid 1-vCPU relay/ }));
  fireEvent.click(prepare);
  await slot.findByText("saved-key");
  const call = slot.inspection.rpcCalls.find(call => call.method === "access.prepare");
  expect(call?.input).toMatchObject({ approveAllocation: true });
  expect(slot.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  expect(slot.getByText(/BB 0.48 uses one default connection/)).toBeTruthy();
  expect(slot.getByText(/server restarts, or relay expiry disconnect existing workers/)).toBeTruthy();
});
it("reuses a retained key after an uncertain prepare and never displays raw errors", async () => {
  const slot = render({
    "access.status": () => ({ ...initial, key: "retained-key" }),
    "access.prepare": () => { throw new Error("PRIVATE KEY secret-token"); },
  });
  const retry = await slot.findByRole("button", { name: "Retry preparation" });
  fireEvent.click(slot.getByRole("checkbox"));
  fireEvent.click(retry);
  const alert = await slot.findByRole("alert");
  expect(alert.textContent).not.toContain("secret-token");
  expect(slot.inspection.rpcCalls.find(call => call.method === "access.prepare")?.input).toEqual({ key: "retained-key", approveAllocation: true });
});
it("keeps a replacement key after an uncertain preparation instead of retrying the removed key", async () => {
  const slot = render({
    "access.status": () => ({ ...initial, key: "old-removed-key", phase: "removed" }),
    "access.prepare": () => { throw new Error("reply lost"); },
  });
  await slot.findByText("old-removed-key");
  fireEvent.click(slot.getByRole("checkbox"));
  fireEvent.click(slot.getByRole("button", { name: "Prepare tunnel" }));
  await slot.findByRole("alert");
  const first = slot.inspection.rpcCalls.find(call => call.method === "access.prepare")?.input;
  expect(first).not.toMatchObject({ key: "old-removed-key" });
  fireEvent.click(slot.getByRole("checkbox"));
  fireEvent.click(slot.getByRole("button", { name: "Retry preparation" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.filter(call => call.method === "access.prepare")).toHaveLength(2));
  expect(slot.inspection.rpcCalls.filter(call => call.method === "access.prepare")[1]?.input).toEqual(first);
});

it("selects only a ready tunnel with explicit global-default consent and offers restoration", async () => {
  const slot = render({
    "access.status": () => ({ ...initial, ready: true, message: "Ready" }),
    "access.select": () => ({ ...initial, ready: true, selected: true, canRestore: true }),
    "access.restore": () => initial,
  });
  await slot.findByText("Ready");
  fireEvent.click(slot.getByRole("button", { name: "Use tunnel for new machines" }));
  await waitFor(() => expect((slot.getByRole("button", { name: "Restore previous default" }) as HTMLButtonElement).disabled).toBe(false));
  expect(slot.inspection.rpcCalls.find(call => call.method === "access.select")?.input).toEqual({ expectedDefault: "direct", approveDefaultChange: true });
  fireEvent.click(slot.getByRole("button", { name: "Restore previous default" }));
  await slot.findByText("Not ready");
  expect(slot.inspection.rpcCalls.map(call => call.method)).not.toContain("access.prepare");
});
