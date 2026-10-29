import { useCallback, useEffect, useState } from "react";
import { useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SETTINGS_PANEL_CLASS } from "./settings-rows.js";
import type { vercelRpcContract } from "./rpc.js";

type Contract = typeof vercelRpcContract;
type Status = PluginRpcResult<Contract["access.status"]>;
type Action = "enable" | "disable";

export function AccessSettings() {
  const rpc = useRpc<Contract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<Action | null>(null);
  const [details, setDetails] = useState(false);
  const read = useCallback(() => rpc.call("access.status", {}), [rpc]);
  useEffect(() => {
    let active = true;
    read().then(value => { if (active) setStatus(value); }, () => {
      if (active) setError("Couldn't load relay status. Try refreshing below.");
    });
    return () => { active = false; };
  }, [read]);
  useEffect(() => {
    if (status?.expiresAt == null) return;
    let active = true;
    const timer = setTimeout(() => {
      read().then(value => { if (active) setStatus(value); }, () => {});
    }, Math.max(0, status.expiresAt - Date.now()) + 100);
    return () => { active = false; clearTimeout(timer); };
  }, [read, status?.expiresAt]);
  const enabled = status?.selected === true;
  const expired = status?.expiresAt != null && status.expiresAt <= Date.now();
  const action: Action = retry ?? (enabled && !expired ? "disable" : "enable");
  const run = async (request: () => Promise<Status>, operation?: Action) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await request());
      setRetry(null);
    } catch {
      if (operation) setRetry(operation);
      setError(operation === "disable"
        ? "Couldn't finish disabling the relay. Retry to finish cleanup; no replacement will be created."
        : "Couldn't finish setting up the relay. Retry to resume the same setup, or open Details to inspect it.");
    } finally { setBusy(false); }
  };
  const label = busy ? "Working…" : retry ? `Retry ${retry}` : action === "disable" ? "Disable relay" : "Enable relay";
  return (
    <section aria-label="Sandbox relay" className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">Sandbox relay</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Connect Vercel sandboxes to this local BB app. Enabling sets up the relay and uses it for new machines automatically.
      </p>
      <div className={`${SETTINGS_PANEL_CLASS} space-y-3 p-3`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p role="status" className="text-xs font-medium">
              {busy ? "Updating relay…" : status === null ? "Loading…" : expired ? "Expired" : enabled && status.ready ? "Enabled" : enabled ? "Unavailable" : status.ready ? "Ready to enable" : "Off"}
            </p>
            <p className="text-xs text-muted-foreground">
              {status?.ready && status.expiresAt ? `Stops at ${new Date(status.expiresAt).toLocaleTimeString()}` : "1 vCPU · Stops after 10 minutes"}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={busy || status === null}
            onClick={() => void run(() => rpc.call(action === "enable" ? "access.enable" : "access.disable", {}), action)}>
            {busy ? <Icon name="Spinner" className="size-3.5 animate-spin" /> : null}{label}
          </Button>
        </div>
        {error ? <p role="alert" className="text-xs text-destructive-text">{error}</p> : null}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Keep this computer awake while working. Disabling restores your previous machine connection. Relay expiry or restarting BB disconnects its workers; reconnecting existing workers isn't supported.
      </p>
      <Button type="button" size="sm" variant="ghost" aria-expanded={details} onClick={() => setDetails(value => !value)}>Details</Button>
      {details ? <div className="space-y-2 text-xs text-muted-foreground">
        <p>{status?.message ?? "Relay status hasn't loaded."}</p>
        {status?.key ? <p className="break-all">Setup: <code>{status.key}</code>{status.phase ? ` · ${status.phase}` : ""}</p> : null}
        <p>BB 0.48 uses this connection for all new machines, not only Vercel sandboxes. Avoid editing Machines settings at the same time.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(read)}>Refresh status</Button>
          {status?.key ? <Button type="button" size="sm" variant="outline" disabled={busy || !status.available}
            onClick={() => void run(() => rpc.call("access.inspect", { key: status.key! }))}>Inspect relay</Button> : null}
          {status?.key && action === "enable" ? <Button type="button" size="sm" variant="ghost" disabled={busy}
            onClick={() => void run(() => rpc.call("access.disable", {}), "disable")}>Disable relay</Button> : null}
        </div>
      </div> : null}
    </section>
  );
}
