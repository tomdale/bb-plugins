import type { BbPluginApi } from "@get-bb/plugin-sdk";

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
}
