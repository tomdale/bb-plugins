import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Hint } from "./hint.tsx";
import { useRuns } from "./hooks.ts";
import { summarizeRuns, summaryLine } from "./status.ts";

export function SubagentsHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { runs, promoted, error, report, rpc, refresh } = useRuns(threadId);
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const summary = summarizeRuns(runs);
  const breakdown = summaryLine(summary);
  const openPanel = () => navigate.openThreadPanel({ actionId: "subagents", title: "Subagents", params: null });
  return <div className="flex items-center gap-1">
    {summary.working > 0 && <Hint label={breakdown}>
      <Button variant="ghost" size="sm" aria-label={`Subagents: ${breakdown}`} onClick={openPanel}>
        <Icon name="Bot" aria-hidden className="size-4 animate-pulse" />
        <span>{summary.working}</span>
      </Button>
    </Hint>}
    {summary.userControlled > 0 && <Hint label={breakdown}>
      <Button variant="outline" size="sm" aria-label={`User-controlled subagents: ${breakdown}`} onClick={openPanel}>
        <Icon name="UserRound" aria-hidden className="size-4" />
        <span>{summary.userControlled}</span>
      </Button>
    </Hint>}
    {promoted?.control === "user" && <Button variant="outline" size="sm" disabled={busy} aria-label="Return control to original thread" onClick={async () => {
      setBusy(true);
      try { const result = await rpc.call("returnControl", { id: promoted.id }); navigate.toThread(result.threadId); refresh(); }
      catch (cause) { report(cause); } finally { setBusy(false); }
    }}>{isCompactViewport ? "Return" : "Return control"}</Button>}
    {error && <Hint label={error}>
      <span role="alert" className="max-w-40 truncate text-xs text-destructive">{error}</span>
    </Hint>}
  </div>;
}
