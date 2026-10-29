import { useCallback, useEffect, useId, useState } from "react";
import { useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SETTINGS_PANEL_CLASS } from "./settings-rows.js";
import type { vercelRpcContract } from "./rpc.js";

type Contract = typeof vercelRpcContract;
type Status = PluginRpcResult<Contract["access.status"]>;

export function AccessSettings() {
  const rpc = useRpc<Contract>();
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const read = useCallback(() => rpc.call("access.status", {}), [rpc]);
  useEffect(() => {
    let active = true;
    read().then(value => { if (active) setStatus(value); }, () => {
      if (active) setError("Couldn't read tunnel setup. Check again; no resources were allocated.");
    });
    return () => { active = false; };
  }, [read]);
  const run = async (action: () => Promise<Status>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      if (next.key !== null) setPendingKey(null);
    }
    catch { setError("Action not confirmed. Inspect the saved tunnel before retrying; don't create a replacement. Check Vercel Access is enabled and compatible. Stop retries cleanup on the original authentication machine."); }
    finally { setBusy(false); }
  };
  const key = pendingKey ?? status?.key;
  const prepare = () => {
    const next = status?.phase === "removed" ? crypto.randomUUID() : key ?? crypto.randomUUID();
    setPendingKey(next);
    setStatus(current => current ? { ...current, key: next, phase: null, expiresAt: null } : current);
    setConsent(false);
    void run(() => rpc.call("access.prepare", { key: next, approveAllocation: true }));
  };
  return (
    <section aria-label="Local BB tunnel" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Local BB tunnel</h3>
        <Button type="button" size="sm" variant="ghost" disabled={busy}
          onClick={() => void run(read)}>Check readiness</Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Use a tunnel in your Vercel account so fresh sandbox threads reach this local BB app. The laptop must stay awake and connected. No BB Connect account is used.
      </p>
      <div className={`${SETTINGS_PANEL_CLASS} space-y-3 p-3`}>
        <p role="status" className="text-xs leading-relaxed">
          {status?.message ?? "Checking tunnel setup…"}
        </p>
        {key ? <p className="break-all text-xs text-muted-foreground">Saved tunnel: <code>{key}</code>{status?.phase ? ` · ${status.phase}` : ""}
          {status?.expiresAt ? ` · Expires ${new Date(status.expiresAt).toLocaleTimeString()}` : ""}</p> : null}
        <div className="flex items-start gap-2">
          <Checkbox id={id} checked={consent} disabled={busy || !status?.available || status.ready}
            onCheckedChange={value => setConsent(value === true)} className="mt-0.5" />
          <Label htmlFor={id} className="text-xs leading-relaxed">
            I approve one paid 1-vCPU relay for up to 10 minutes in the connected Vercel account. This does not create a worker or change machine defaults.
          </Label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy || !status?.available || !consent || status.ready} onClick={prepare}>
            {key && status?.phase !== "removed" ? "Retry preparation" : "Prepare tunnel"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !key || !status?.available}
            onClick={() => key && void run(() => rpc.call("access.inspect", { key }))}>Inspect tunnel</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !key || !status?.available || status.ready || status.phase !== "ready" || status.defaultProvider === null}
            onClick={() => key && void run(() => rpc.call("access.activate", { key }))}>Connect tunnel</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy || !key || !status?.available}
            onClick={() => key && void run(() => rpc.call("access.stop", { key }))}>Stop tunnel</Button>
        </div>
        {busy ? <p role="status" className="text-xs text-muted-foreground">Working… Don't prepare another tunnel while this action is unresolved.</p> : null}
        {error ? <p role="alert" className="text-xs text-destructive-text">{error}</p> : null}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Prepare, inspect, then connect. Check readiness until ready. Connecting reloads Vercel Access and invalidates old grants: do it only before launching a fresh worker. Reloads, server restarts, or relay expiry disconnect existing workers; reconnecting them is not supported.
      </p>
      <div className="space-y-2">
        {status?.defaultProvider === null ? <p className="text-xs text-warning-text">Choose an explicit connection in Settings → Machines before connecting. Automatic can select any registered provider, including this tunnel.</p> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          BB 0.48 uses one default connection for all new machines. Current default: <span className="text-foreground">{status ? status.selected ? "Vercel tunnel" : status.defaultProvider ?? "Automatic" : "Loading…"}</span>. Select the ready tunnel, create a new thread with the Vercel Sandbox environment, wait until its machine connects, then restore your previous default here. Restoring does not change existing machines. Avoid changing Machines settings at the same time. Stop the relay only after its workers finish.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy || !status?.ready || status.selected}
            onClick={() => status && void run(() => rpc.call("access.select", { expectedDefault: status.defaultProvider, approveDefaultChange: true }))}>
            Use tunnel for new machines
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !status?.canRestore}
            onClick={() => void run(() => rpc.call("access.restore", {}))}>Restore previous default</Button>
        </div>
      </div>
    </section>
  );
}
