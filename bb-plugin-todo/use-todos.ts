import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import { emptyState, type Input, type State } from "./model.js";

export interface TodoList {
  state: State;
  /** True once a snapshot for the current thread has arrived. */
  loaded: boolean;
  error: string | null;
  refresh: () => void;
  /** Applies one reducer change; resolves false and records the error when the server rejects it. */
  mutate: (change: Input) => Promise<boolean>;
  dismissError: () => void;
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * Reads one thread's Todo state and keeps it current. Plugin realtime signals
 * are not replayed, so the snapshot is also refetched after reconnects. Each
 * request carries a generation so a slow response for a previous thread can't
 * overwrite the current one.
 */
export function useTodoList(threadId: string | null): TodoList {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<State>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    if (!threadId) { setState(emptyState()); setLoaded(false); setError(null); return; }
    rpc.call("snapshot", { threadId }).then(next => {
      if (generation.current === request) { setState(next); setLoaded(true); setError(null); }
    }, cause => {
      if (generation.current === request) setError(message(cause));
    });
  }, [rpc, threadId]);
  useEffect(() => {
    setState(emptyState());
    setLoaded(false);
    refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useEffect(() => { if (connection === "connected") refresh(); }, [connection, refresh]);
  useRealtime("todo-changed", payload => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  const mutate = useCallback(async (change: Input) => {
    if (!threadId) return false;
    const request = ++generation.current;
    try {
      const next = await rpc.call("mutate", { threadId, change });
      if (generation.current === request) { setState(next); setLoaded(true); }
      setError(null);
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    }
  }, [rpc, threadId]);
  const dismissError = useCallback(() => setError(null), []);
  return { state, loaded, error, refresh, mutate, dismissError };
}
