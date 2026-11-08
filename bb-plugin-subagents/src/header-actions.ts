import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadActionDataInput, PluginThreadActionRegistration } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Run } from "./contracts.ts";
import { summarizeRuns } from "./status.ts";

type ThreadRuns = { runs: Run[] };

/**
 * Live run data for the threads whose headers are on screen. `useData` runs
 * once for the whole app rather than per thread, so the per-thread lists and
 * the rpc client live here; the plugin's realtime channel refreshes on every
 * run change.
 */
export function useSubagentsHeaderData({ threadIds }: PluginThreadActionDataInput) {
  const rpc = useRpc<typeof rpcContract>();
  const [lists, setLists] = useState<Record<string, ThreadRuns>>({});
  const [refresh, setRefresh] = useState(0);
  useRealtime("changed", () => setRefresh(value => value + 1));
  const ids = threadIds.join(",");
  useEffect(() => {
    let current = true;
    void Promise.all(
      (ids ? ids.split(",") : []).map(async threadId => [threadId, await rpc.call("list", { threadId })] as const),
    ).then(
      entries => {
        if (current) setLists(Object.fromEntries(entries));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [ids, refresh, rpc]);
  return { rpc, lists };
}

export type SubagentsHeaderData = ReturnType<typeof useSubagentsHeaderData>;

/** Header button showing this thread's active subagents; opens the panel tab. */
export const subagentsStatusAction: PluginThreadActionRegistration<SubagentsHeaderData> = {
  id: "subagents",
  title: "Subagents",
  icon: "Bot",
  group: "subagents",
  placement: "header",
  useData: useSubagentsHeaderData,
  item: ({ thread, data, experimental_panel }) => {
    const list = data?.lists[thread.id];
    if (!list) return null;
    const summary = summarizeRuns(list.runs);
    if (summary.working === 0) return null;
    return {
      label: `Subagents · ${summary.working} running`,
      icon: "Bot",
      run: () => {
        experimental_panel.openTab({
          tab: { id: "subagents", context: { kind: "thread" }, availability: "action" },
          params: { threadId: thread.id },
        });
      },
    };
  },
};
