import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The Handoff plugin ships one agent skill, `handoff`, which BB exposes to
 * every provider as the `/handoff` slash command. The workflow runs through
 * the `bb` CLI (`thread spawn`, `thread archive`) and Workforest (`wf new`), so
 * the server entry registers nothing.
 */
export default function plugin(_bb: BbPluginApi) {}
