import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useRuns } from "./hooks.ts";

export function SubagentsHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
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
