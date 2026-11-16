import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  RING_ACTIONS_CHANNEL,
  rpcContract,
  sanitizeRingActions,
  type RingAction,
} from "./ring-actions";

const RING_ACTIONS_KEY = "ring-actions";

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    trigger: {
      type: "select",
      label: "Menu trigger",
      options: ["hold-option", "corner"],
      experimental_optionLabels: {
        "hold-option": "Hold Option at the pointer",
        corner: "Corner button",
      },
      default: "hold-option",
    },
    rightClick: {
      type: "boolean",
      label: "Right-click opens the menu",
      default: true,
    },
    corner: {
      type: "select",
      label: "Menu corner",
      options: ["bottom-left", "bottom-right", "top-left", "top-right"],
      experimental_optionLabels: {
        "bottom-left": "Bottom left",
        "bottom-right": "Bottom right",
        "top-left": "Top left",
        "top-right": "Top right",
      },
      default: "bottom-left",
    },
    motion: {
      type: "select",
      label: "Menu motion",
      options: ["ring", "arc"],
      experimental_optionLabels: {
        ring: "Ring bloom",
        arc: "Arc spring",
      },
      default: "ring",
    },
    debugRegions: {
      type: "boolean",
      label: "Debug hover regions",
      default: false,
    },
  });

  const readRingActions = async () =>
    sanitizeRingActions(await bb.storage.kv.get<RingAction[]>(RING_ACTIONS_KEY));

  bb.rpc.register(rpcContract, {
    ringActions: async () => ({ actions: await readRingActions() }),
    setRingActions: async ({ actions }) => {
      if (actions === null) await bb.storage.kv.delete(RING_ACTIONS_KEY);
      else await bb.storage.kv.set(RING_ACTIONS_KEY, actions);
      const saved = await readRingActions();
      // Every open window refetches, so each ring and settings view agrees.
      bb.realtime.publish(RING_ACTIONS_CHANNEL, null);
      return { actions: saved };
    },
  });
}
