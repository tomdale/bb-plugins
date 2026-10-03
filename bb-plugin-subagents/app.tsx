import { useCallback, useEffect, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, ThreadChat, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Run } from "./src/contracts.ts";
import { Button } from "./components/ui/button.js";

function useRuns(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{ runs: Run[]; promoted: Run | null }>({ runs: [], promoted: null });
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refresh = useCallback(() => {
    let current = true;
    void rpc.call("list", { threadId }).then(value => { if (current) { setData(value); setError(null); } }, cause => { if (current) report(cause); });
    return () => { current = false; };
  }, [rpc, threadId, report]);
  useEffect(() => { setData({ runs: [], promoted: null }); return refresh(); }, [refresh]);
  useRealtime("changed", () => { refresh(); });
  const connection = useRealtimeConnectionState();
  useEffect(() => { if (connection === "connected") return refresh(); }, [connection, refresh]);
  return { ...data, error, report, rpc, refresh };
}

function SubagentsPanel({ threadId }: PluginThreadPanelProps) {
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

function SubagentsHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { runs, promoted, error, report, rpc, refresh } = useRuns(threadId);
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  return <div className="flex items-center gap-1">
    {runs.length > 0 && <Button variant="ghost" size="sm" aria-label={`View ${runs.length} subagents`} onClick={() => navigate.openThreadPanel({ actionId: "subagents", title: "Subagents", params: null })}>
      <Icon name="Bot" aria-hidden className="size-4" />
      <span>{runs.length}</span>
    </Button>}
    {promoted?.control === "user" && <Button variant="outline" size="sm" disabled={busy} aria-label="Return control to original thread" onClick={async () => {
      setBusy(true);
      try { const result = await rpc.call("returnControl", { id: promoted.id }); navigate.toThread(result.threadId); refresh(); }
      catch (cause) { report(cause); } finally { setBusy(false); }
    }}>{isCompactViewport ? "Return" : "Return control"}</Button>}
    {error && <span role="alert" title={error} className="max-w-40 truncate text-xs text-destructive">{error}</span>}
  </div>;
}

export default definePluginApp(app => {
  app.slots.threadPanelAction({ id: "subagents", title: "Subagents", icon: "GitFork", layout: "flush", component: SubagentsPanel });
  app.slots.experimental_threadHeaderAction({ id: "subagents", title: "Subagents", component: SubagentsHeader });
});
