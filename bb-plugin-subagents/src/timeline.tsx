import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import type { Run } from "./contracts.ts";
import { useRuns } from "./hooks.ts";
import { runTone, runStatusLabel, type RunTone } from "./status.ts";

/** Text tint per run tone, from BB's status color tokens. */
const TONE_TEXT_CLASS: Record<RunTone, string> = {
  running: "text-success",
  success: "text-success-foreground",
  error: "text-destructive",
  attention: "text-attention",
  muted: "text-muted-foreground",
};

/** One attribute as a display string, or a fallback when it is absent. */
function displayAttribute(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

interface RunCardData {
  tone: RunTone;
  statusLabel: string;
  title: string;
  /** The worker thread, present only for a live, user-controlled run. */
  threadId: string | null;
}

function runCardData(run: Run): RunCardData {
  return { tone: runTone(run), statusLabel: runStatusLabel(run), title: run.title, threadId: run.threadId };
}

function RunStatusCard({ data, onOpenThread }: {
  data: RunCardData;
  /** Offered only while the user controls the run; other worker threads are hidden. */
  onOpenThread: ((threadId: string) => void) | null;
}) {
  const { tone, statusLabel, title, threadId } = data;
  return <div className="my-1 flex max-w-full items-center gap-2">
    <Badge variant="outline" className={cn("shrink-0 border-transparent", TONE_TEXT_CLASS[tone])}>{statusLabel}</Badge>
    <span className="min-w-0 truncate text-xs text-foreground">{title}</span>
    {onOpenThread && threadId !== null && <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => onOpenThread(threadId)}>Open thread</Button>}
  </div>;
}

/**
 * Live status card for the `subagent-run` message directive the server appends
 * to every run notification. The directive attributes are a stale snapshot from
 * notification time; the live run record wins whenever the run is still listed,
 * and the attributes remain as a fallback for old messages and archived runs.
 * Without a usable id the card renders nothing — the surrounding message text
 * already carries the information.
 */
export function SubagentRunDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const { runs } = useRuns(message.threadId);
  const navigate = useBbNavigate();
  const id = typeof attributes.id === "string" && attributes.id.trim() ? attributes.id : "";
  if (!id) return null;
  const run = runs.find(candidate => candidate.id === id);
  if (!run) {
    return <RunStatusCard onOpenThread={null} data={{
      tone: "muted",
      statusLabel: displayAttribute(attributes.status, "Unknown"),
      title: displayAttribute(attributes.title, "Subagent"),
      threadId: null,
    }} />;
  }
  return <RunStatusCard data={runCardData(run)} onOpenThread={run.control === "user" ? threadId => navigate.toThread(threadId) : null} />;
}
