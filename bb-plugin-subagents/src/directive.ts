import type { Run } from "./contracts.ts";

/** The message directive id the plugin renders as a live run card. */
export const RUN_DIRECTIVE_ID = "subagent-run";

/** Directive attribute values are quoted, so backslashes and quotes are escaped; whitespace collapses. */
function directiveAttribute(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ");
}

/**
 * One micromark leaf directive describing the run at notification time. The
 * directive component treats these attributes as a stale fallback and prefers
 * the live run record.
 */
export function runDirectiveLine(run: Pick<Run, "id" | "status" | "title" | "threadId">): string {
  return `::${RUN_DIRECTIVE_ID}{id="${directiveAttribute(run.id)}" status="${run.status}" title="${directiveAttribute(run.title)}" thread="${directiveAttribute(run.threadId ?? "")}"}`;
}
