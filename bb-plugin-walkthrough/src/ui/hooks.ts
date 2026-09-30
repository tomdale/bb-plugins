import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../rpc.ts";
import { CHANGED_CHANNEL, type WalkthroughView } from "../schemas.ts";

export type WalkthroughRpc = PluginRpcClient<typeof rpcContract>;

export function useWalkthroughRpc(): WalkthroughRpc {
  return useRpc<typeof rpcContract>();
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface ChangedSignal {
  threadId: string;
  reason: "started" | "changed";
  walkthroughId: string | null;
}

function parseSignal(payload: unknown): ChangedSignal | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.threadId !== "string") return null;
  return {
    threadId: record.threadId,
    reason: record.reason === "started" ? "started" : "changed",
    walkthroughId: typeof record.walkthroughId === "string" ? record.walkthroughId : null,
  };
}

/**
 * The thread's walkthrough view, refetched on every server change signal and
 * after a realtime reconnect (signals are not replayed).
 */
export function useWalkthrough(threadId: string, onStarted?: (walkthroughId: string) => void) {
  const rpc = useWalkthroughRpc();
  const [view, setView] = useState<WalkthroughView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const request = ++generation.current;
    rpc.call("get", { threadId }).then(
      (result) => {
        if (generation.current !== request) return;
        setView(result.view);
        setLoaded(true);
        setError(null);
      },
      (cause: unknown) => {
        if (generation.current === request) setError(errorMessage(cause));
      },
    );
  }, [rpc, threadId]);
  useEffect(() => {
    setView(null);
    setLoaded(false);
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
  const startedRef = useRef(onStarted);
  startedRef.current = onStarted;
  useRealtime(CHANGED_CHANNEL, (payload) => {
    const signal = parseSignal(payload);
    if (signal === null || signal.threadId !== threadId) return;
    refetch();
    if (signal.reason === "started" && signal.walkthroughId) startedRef.current?.(signal.walkthroughId);
  });
  return { view, loaded, error, refetch, rpc };
}

// ---------------------------------------------------------------------------
// Note drafts handed from a message action to the panel's note composer.
// Keyed by thread so split panes never see each other's draft.
// ---------------------------------------------------------------------------

export interface NoteDraft {
  quote: string;
  sequence: number;
}

const drafts = new Map<string, NoteDraft>();
const draftListeners = new Set<() => void>();
let draftSequence = 0;

export function offerNoteDraft(threadId: string, quote: string): void {
  draftSequence += 1;
  drafts.set(threadId, { quote, sequence: draftSequence });
  for (const listener of draftListeners) listener();
}

export function clearNoteDraft(threadId: string): void {
  if (drafts.delete(threadId)) for (const listener of draftListeners) listener();
}

function subscribeDrafts(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}

export function useNoteDraft(threadId: string): NoteDraft | null {
  return useSyncExternalStore(
    subscribeDrafts,
    () => drafts.get(threadId) ?? null,
    () => null,
  );
}
