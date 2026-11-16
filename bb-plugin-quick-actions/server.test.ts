import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { DEFAULT_RING_ACTIONS, sanitizeRingActions } from "./ring-actions";

const SNOOZE = { key: "workstreams/snooze", title: "Snooze", icon: "Clock" };

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "quick-actions" });
  await plugin(bb);
  return { bb, harness };
}

describe("ring actions", () => {
  it("reports no saved ring until one is saved", async () => {
    const { harness } = await setup();
    expect(await harness.callRpc("ringActions", {})).toEqual({ actions: null });
  });

  it("saves a ring, tells every window, and restores the default on null", async () => {
    const { harness } = await setup();
    const ring = [DEFAULT_RING_ACTIONS[0], SNOOZE];
    expect(await harness.callRpc("setRingActions", { actions: ring })).toEqual({ actions: ring });
    expect(await harness.callRpc("ringActions", {})).toEqual({ actions: ring });
    expect(harness.realtimeSignals).toEqual([{ channel: "ring-actions", payload: null }]);

    expect(await harness.callRpc("setRingActions", { actions: null })).toEqual({ actions: null });
    expect(await harness.callRpc("ringActions", {})).toEqual({ actions: null });
  });

  it("refuses an empty ring, a repeated action, more than ten, or a malformed key", async () => {
    const { harness } = await setup();
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `p/a${i}`, title: `A${i}`, icon: "Zap" }));
    for (const actions of [[], [SNOOZE, SNOOZE], many, [{ ...SNOOZE, key: "snooze" }]]) {
      await expect(harness.callRpc("setRingActions", { actions })).rejects.toThrow();
    }
    expect(await harness.callRpc("ringActions", {})).toEqual({ actions: null });
  });

  it("reads a damaged stored ring as its valid actions", () => {
    expect(sanitizeRingActions("nope")).toBeNull();
    expect(sanitizeRingActions([{ key: "bad" }])).toBeNull();
    expect(sanitizeRingActions([SNOOZE, { key: "x" }, SNOOZE, DEFAULT_RING_ACTIONS[1]])).toEqual([
      SNOOZE,
      DEFAULT_RING_ACTIONS[1],
    ]);
  });
});
