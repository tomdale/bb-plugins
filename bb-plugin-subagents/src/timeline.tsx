import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";

/**
 * Placeholder renderer for the `subagent-run` message directive carried by
 * every run notification; the live status card replaces this.
 */
export function SubagentRunDirective({ attributes }: PluginMessageDirectiveProps) {
  const title = typeof attributes.title === "string" && attributes.title ? attributes.title : "Subagent";
  const status = typeof attributes.status === "string" && attributes.status ? attributes.status : "unknown";
  return <p className="text-xs text-muted-foreground">Subagent {title} — {status}</p>;
}
