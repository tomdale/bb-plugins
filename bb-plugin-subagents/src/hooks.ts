import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Run } from "./contracts.ts";

export function useRuns(threadId: string) {
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
