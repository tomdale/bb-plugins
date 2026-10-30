import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { rpcContract, WalkthroughSummary } from "../rpc.ts";
import { CHANGED_CHANNEL, STREAM_CHANNEL, type WalkthroughView } from "../schemas.ts";
import { applyPayload, readPayload, type StreamState } from "./stream.ts";

export type WalkthroughRpc = PluginRpcClient<typeof rpcContract>;

export function useWalkthroughRpc(): WalkthroughRpc {
  return useRpc<typeof rpcContract>();
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface ChangedSignal {
  threadId: string;
  walkthroughId: string;
  reason: "started" | "changed";
}

function parseSignal(payload: unknown): ChangedSignal | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.threadId !== "string" || typeof record.walkthroughId !== "string") return null;
  return { threadId: record.threadId, walkthroughId: record.walkthroughId, reason: record.reason === "started" ? "started" : "changed" };
}

/** Refetches on change signals and after a realtime reconnect (signals are not replayed). */
function useLiveQuery<T>(load: () => Promise<T>, matches: (signal: ChangedSignal) => boolean, onSignal?: (signal: ChangedSignal) => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const request = ++generation.current;
    load().then(
      (result) => {
        if (generation.current !== request) return;
        setData(result);
        setError(null);
      },
      (cause: unknown) => {
        if (generation.current === request) setError(errorMessage(cause));
      },
    );
  }, [load]);
  useEffect(() => {
    setData(null);
    refetch();
    return () => {
      generation.current += 1;
    };
  }, [refetch]);
  const connection = useRealtimeConnectionState();
  const lastConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && lastConnection.current !== "connected") refetch();
    lastConnection.current = connection;
  }, [connection, refetch]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;
  useRealtime(CHANGED_CHANNEL, (payload) => {
    const signal = parseSignal(payload);
    if (signal === null || !matchesRef.current(signal)) return;
    refetch();
    onSignalRef.current?.(signal);
  });
  return { data, error, refetch };
}

export function useWalkthrough(walkthroughId: string | null) {
  const rpc = useWalkthroughRpc();
  // The view is wrapped so a walkthrough that does not exist (`view: null`) still counts as loaded.
  const load = useCallback(
    async (): Promise<{ view: WalkthroughView | null }> => ({ view: walkthroughId ? (await rpc.call("get", { walkthroughId })).view : null }),
    [rpc, walkthroughId],
  );
  const { data, error } = useLiveQuery(load, (signal) => signal.walkthroughId === walkthroughId);
  return { view: data?.view ?? null, loaded: data !== null || walkthroughId === null, error, rpc };
}

export function useThreadWalkthroughs(threadId: string, onStarted?: (signal: ChangedSignal) => void) {
  const rpc = useWalkthroughRpc();
  const load = useCallback(async (): Promise<WalkthroughSummary[]> => (await rpc.call("list", { threadId })).walkthroughs, [rpc, threadId]);
  const { data } = useLiveQuery(
    load,
    (signal) => signal.threadId === threadId,
    (signal) => {
      if (signal.reason === "started") onStarted?.(signal);
    },
  );
  return { walkthroughs: data ?? [], rpc };
}

/** Walkthroughs from every thread, newest first. */
export function useRecentWalkthroughs() {
  const rpc = useWalkthroughRpc();
  const load = useCallback(async (): Promise<WalkthroughSummary[]> => (await rpc.call("recent", {})).walkthroughs, [rpc]);
  const { data, error } = useLiveQuery(load, () => true);
  return { walkthroughs: data, error };
}

/** Tracks an element's width so the pane can switch layouts. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const NO_STREAMS: StreamState = Object.freeze({});

/**
 * The worker's message text for one walkthrough, as it is written. Follows the
 * stream channel, and asks for a snapshot when the pane opens mid-stream, when a
 * new request starts, and after a realtime reconnect (payloads are not
 * replayed). Payloads that arrive late, twice, or out of order are folded by
 * their seq; payloads after unmount are dropped.
 */
export function useStreams(walkthroughId: string, requestKey: string | null, rpc: WalkthroughRpc): StreamState {
  const [state, setState] = useState<StreamState>(NO_STREAMS);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Another walkthrough starts from nothing.
  useEffect(() => setState(NO_STREAMS), [walkthroughId]);
  const take = useCallback(
    (value: unknown) => {
      const payload = readPayload(value);
      if (payload === null || payload.walkthroughId !== walkthroughId || !mounted.current) return;
      setState((current) => applyPayload(current, payload));
    },
    [walkthroughId],
  );
  useRealtime(STREAM_CHANNEL, take);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (requestKey === null || connection === "reconnecting") return;
    rpc.call("streamSnapshot", { walkthroughId }).then(
      (result) => take(result.snapshot),
      () => undefined,
    );
  }, [rpc, walkthroughId, requestKey, connection, take]);
  return state;
}
