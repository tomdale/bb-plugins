import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import { emptyState, type State } from "./model.js";

export interface TodoList {
  state: State;
  /** Milliseconds since the plan last changed, as of the latest snapshot. */
  ageMs: number;
  /** True once a snapshot for the current thread has arrived. */
  loaded: boolean;
  error: string | null;
  refresh: () => void;
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const EMPTY = emptyState();

/**
 * Reads one thread's Todo state and keeps it current. Plugin realtime signals
 * are not replayed, so the snapshot is also refetched after reconnects. Each
 * snapshot and failure is stored with its thread id, so a render for a new
 * thread never shows the previous thread's plan, and each request carries a
 * generation so a slow response for a previous thread can't overwrite the
 * current one.
 */
export function useTodoList(threadId: string | null): TodoList {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [snapshot, setSnapshot] = useState<{ threadId: string; state: State; ageMs: number } | null>(null);
  const [failure, setFailure] = useState<{ threadId: string; message: string } | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    if (!threadId) return;
    rpc.call("snapshot", { threadId }).then(next => {
      if (generation.current !== request) return;
      const { ageMs, ...state } = next;
      setSnapshot({ threadId, state, ageMs });
      setFailure(null);
    }, cause => {
      if (generation.current === request) setFailure({ threadId, message: message(cause) });
    });
  }, [rpc, threadId]);
  useEffect(() => {
    refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useEffect(() => { if (connection === "connected") refresh(); }, [connection, refresh]);
  useRealtime("todo-changed", payload => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  const current = threadId !== null && snapshot?.threadId === threadId ? snapshot : null;
  return {
    state: current?.state ?? EMPTY,
    ageMs: current?.ageMs ?? 0,
    loaded: current !== null,
    error: threadId !== null && failure?.threadId === threadId ? failure.message : null,
    refresh,
  };
}
