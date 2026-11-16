import { useCallback, useState } from "react";
import { experimental_useRpcQuery, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_RING_ACTIONS,
  RING_ACTIONS_CHANNEL,
  rpcContract,
  type RingAction,
} from "./ring-actions";

const NO_INPUT = {};

export type RingActionsState = {
  /** The ring's actions in ring order; the default until a saved list loads. */
  actions: readonly RingAction[];
  /** The saved list has loaded, so a write can't replace something unseen. */
  loaded: boolean;
  /** The user has a list of their own. */
  customized: boolean;
  /** Saves a list, or restores the default with null. Rejects on failure. */
  save(actions: readonly RingAction[] | null): Promise<void>;
};

/**
 * The ring's actions as the server stores them, refetched whenever any window
 * saves. A save shows at once and stays until the server's copy returns.
 */
export function useRingActions(): RingActionsState {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "ringActions",
    input: NO_INPUT,
  });
  const rpc = useRpc<typeof rpcContract>();
  const { refetch } = query;
  useRealtime(RING_ACTIONS_CHANNEL, () => {
    void refetch();
  });
  const [pending, setPending] = useState<{ actions: readonly RingAction[] | null } | null>(null);
  const save = useCallback(
    async (actions: readonly RingAction[] | null) => {
      const next = { actions };
      setPending(next);
      try {
        await rpc.call("setRingActions", { actions: actions === null ? null : [...actions] });
        await refetch();
      } finally {
        setPending((current) => (current === next ? null : current));
      }
    },
    [refetch, rpc],
  );
  const stored = pending ? pending.actions : query.data?.actions;
  return {
    actions: stored ?? DEFAULT_RING_ACTIONS,
    loaded: query.data !== undefined,
    customized: stored !== null && stored !== undefined,
    save,
  };
}
