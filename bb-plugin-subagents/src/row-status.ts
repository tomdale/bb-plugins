import type { PluginContentScriptRegistration } from "@get-bb/plugin-sdk/app";

/**
 * Placeholder content script; the sidebar thread-row status glyph replaces
 * this. `mount` must return a disposer or nothing, and feature-detects
 * `experimental_setThreadRowStatus` at runtime.
 */
export const rowStatusScript: PluginContentScriptRegistration = { id: "row-status", mount() {} };
