import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { useRuns } from "./hooks.ts";

export function SubagentsPanel({ threadId }: PluginThreadPanelProps) {
  const { runs, error, report, rpc, refresh } = useRuns(threadId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useBbNavigate();
  const selected = runs.find(run => run.id === selectedId) ?? runs[0];
  return <section className="flex h-full min-h-0 flex-col" aria-label="Subagents">
    <div className="space-y-2 border-b border-border p-3">
      <p className="text-xs text-muted-foreground">Background agents share this workspace. Transcripts are read-only here.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {runs.length === 0 ? <p role="status" className="text-sm text-muted-foreground">No subagent runs yet.</p> : <>
        <label className="block text-xs">Run
          <select className="mt-1 w-full rounded border border-input bg-background p-2 text-sm" value={selected?.id ?? ""} onChange={event => setSelectedId(event.target.value)}>
            {runs.map(run => <option key={run.id} value={run.id}>{run.title} · {run.control === "user" ? "User controlled" : run.status}</option>)}
          </select>
        </label>
        {selected && <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{selected.status} · depth {selected.depth}</span>
          <Button size="sm" disabled={busy || !selected.threadId} onClick={async () => {
            setBusy(true);
            try { const result = await rpc.call("promote", { id: selected.id }); navigate.toThread(result.threadId); refresh(); }
            catch (cause) { report(cause); } finally { setBusy(false); }
          }}>{selected.control === "user" ? "Open thread" : "Take control"}</Button>
        </div>}
        {selected?.error && <p className="text-sm text-destructive">{selected.error}</p>}
      </>}
    </div>
    {selected?.threadId && <ThreadChat key={selected.threadId} threadId={selected.threadId} variant="timeline" className="min-h-0 flex-1" />}
  </section>;
}
