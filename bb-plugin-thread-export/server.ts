import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Thread Export runs entirely in the bb app: it snapshots bb's own rendered
 * transcript and saves it through the host's download path. The manifest
 * requires a backend entry, and it has nothing to register.
 */
export default function plugin(_bb: BbPluginApi): void {}
