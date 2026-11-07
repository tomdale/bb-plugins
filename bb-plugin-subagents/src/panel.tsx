import { useMemo, useState } from "react";
import { ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadTabProps, JsonValue } from "@get-bb/plugin-sdk/app";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { Separator } from "../components/ui/separator.js";
import { cn } from "../lib/utils.js";
import { useRuns } from "./hooks.ts";
import type { Run } from "./contracts.ts";
import { runIsWorking, runStatusLabel, runTone, summarizeRuns, summaryLine } from "./status.ts";
import type { RunTone } from "./status.ts";

/** A run's age relative to `now`, as "12s", "12m", "3h", or "2d". */
function relativeAge(createdAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** Badge treatment per run tone, using the variants badge.tsx ships. */
function toneBadge(tone: RunTone): { variant: BadgeVariant; className?: string } {
  switch (tone) {
    case "running":
      // The one tone where BB's accent reads as activity.
      return { variant: "outline", className: "border-primary/40 text-primary" };
    case "attention":
      return { variant: "default" };
    case "success":
      return { variant: "secondary" };
    case "muted":
      return { variant: "outline", className: "text-muted-foreground" };
    case "error":
      return { variant: "destructive" };
  }
}

/** One short sentence-case count line, omitting everything at zero. */
function summaryText(runs: readonly Run[]): string {
  return summaryLine(summarizeRuns(runs));
}

export function SubagentsPanel({ threadId }: ExperimentalThreadTabProps & { params: JsonValue | null }) {
  const { runs, error, report, rpc, refresh } = useRuns(threadId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useBbNavigate();
  // Newest first, the order the list shows and auto-selection picks from.
  const ordered = useMemo(() => [...runs].sort((a, b) => b.createdAt - a.createdAt), [runs]);
  const autoSelected = useMemo(() => ordered.find(runIsWorking) ?? ordered[0] ?? null, [ordered]);
  // The user's pick is sticky, but only while that run still exists.
  const selected = (selectedId !== null ? runs.find(run => run.id === selectedId) : undefined) ?? autoSelected;
  return <section className="flex h-full min-h-0 flex-col" aria-label="Subagents">
    <div className="space-y-2 border-b border-border p-3">
      <p className="text-xs text-muted-foreground">Background agents share this workspace. Transcripts are read-only here.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {runs.length === 0 ? <p role="status" className="text-sm text-muted-foreground">No subagent runs yet.</p> : <>
        <p className="text-xs text-muted-foreground">{summaryText(runs)}</p>
        <ScrollArea className="max-h-56">
          <ul className="flex flex-col gap-0.5 py-1">
            {ordered.map(run => {
              const isSelected = run.id === selected?.id;
              const { variant, className: badgeClassName } = toneBadge(runTone(run));
              return <li key={run.id}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedId(run.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded-md border border-transparent p-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    isSelected ? "border-border bg-state-active" : "hover:bg-state-hover",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.title}</span>
                    <Badge variant={variant} className={cn("shrink-0", badgeClassName)}>{runStatusLabel(run)}</Badge>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {run.depth > 1 && <span>depth {run.depth}</span>}
                    <span>{relativeAge(run.createdAt)}</span>
                  </span>
                </button>
              </li>;
            })}
          </ul>
        </ScrollArea>
        {selected && <>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-xs text-muted-foreground">{runStatusLabel(selected)} · depth {selected.depth}</span>
            <Button size="sm" disabled={busy || !selected.threadId} onClick={async () => {
              setBusy(true);
              try { const result = await rpc.call("promote", { id: selected.id }); navigate.toThread(result.threadId); refresh(); }
              catch (cause) { report(cause); } finally { setBusy(false); }
            }}>{selected.control === "user" ? "Open thread" : "Take control"}</Button>
          </div>
          {selected.error && <p className="text-sm text-destructive">{selected.error}</p>}
        </>}
      </>}
    </div>
    {selected?.threadId && <ThreadChat key={selected.threadId} threadId={selected.threadId} variant="timeline" className="min-h-0 flex-1" />}
  </section>;
}
