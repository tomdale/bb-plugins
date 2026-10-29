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
it("reads without allocation and enables with one click and no consent prompt", async () => {
  const slot = render({ "access.enable": () => ({ ...initial, ready: true, selected: true, key: "saved-key" }) });
  await slot.findByText("Off");
  expect(slot.inspection.rpcCalls.map(call => call.method)).toEqual(["access.status"]);
  expect(slot.queryByRole("checkbox")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Enable relay" }));
  await slot.findByText("Enabled");
  expect(slot.inspection.rpcCalls.find(call => call.method === "access.enable")?.input).toEqual({});
  expect(slot.getByRole("button", { name: "Disable relay" })).toBeTruthy();
  expect(slot.queryByText("saved-key")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Details" }));
  await slot.findByText("saved-key");
});
it("uses one disable action and keeps diagnostics out of the main flow", async () => {
  const slot = render({
    "access.status": () => ({ ...initial, ready: true, selected: true }),
    "access.disable": () => initial,
  });
  await slot.findByText("Enabled");
  fireEvent.click(slot.getByRole("button", { name: "Disable relay" }));
  await slot.findByText("Off");
  expect(slot.queryByRole("button", { name: "Inspect relay" })).toBeNull();
  expect(slot.inspection.rpcCalls.map(call => call.method)).toEqual(["access.status", "access.disable"]);
});
it("redacts errors and retries the failed action rather than guessing from stale status", async () => {
  let fail = true;
  const slot = render({
    "access.disable": () => { if (fail) throw new Error("PRIVATE KEY secret-token"); return initial; },
    "access.status": () => ({ ...initial, ready: true, selected: true }),
  });
  await slot.findByText("Enabled");
  fireEvent.click(slot.getByRole("button", { name: "Disable relay" }));
  expect((await slot.findByRole("alert")).textContent).not.toContain("secret-token");
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry disable" }));
  await slot.findByText("Off");
  expect(slot.inspection.rpcCalls.filter(call => call.method === "access.disable")).toHaveLength(2);
});
it("offers one enable action to renew an expired selected relay", async () => {
  const slot = render({
    "access.status": () => ({ ...initial, selected: true, expiresAt: Date.now() - 1000 }),
    "access.enable": () => ({ ...initial, ready: true, selected: true }),
  });
  await slot.findByText("Expired");
  fireEvent.click(slot.getByRole("button", { name: "Enable relay" }));
  await slot.findByText("Enabled");
});

it("offers one enable action even when the companion isn't running", async () => {
  const slot = render({ "access.status": () => ({ ...initial, available: false }) });
  await slot.findByText("Off");
  await waitFor(() => expect((slot.getByRole("button", { name: "Enable relay" }) as HTMLButtonElement).disabled).toBe(false));
});
