import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadActionDataInput, PluginThreadActionRegistration } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Run } from "./contracts.ts";
import { summarizeRuns } from "./status.ts";

type ThreadRuns = { runs: Run[]; promoted: Run | null };

/**
 * Live run data for the threads whose headers are on screen. `useData` runs
 * once for the whole app rather than per thread, so the per-thread lists and
 * the rpc client (for `run` callbacks, which run outside React) both live
 * here; the plugin's realtime channel refreshes on every run change.
 */
export function useSubagentsHeaderData({ threadIds }: PluginThreadActionDataInput) {
  const rpc = useRpc<typeof rpcContract>();
  const [lists, setLists] = useState<Record<string, ThreadRuns>>({});
  const [refresh, setRefresh] = useState(0);
  useRealtime("changed", () => setRefresh(value => value + 1));
  const ids = threadIds.join(",");
  useEffect(() => {
    let current = true;
    void Promise.all((ids ? ids.split(",") : []).map(async threadId => [threadId, await rpc.call("list", { threadId })] as const))
      .then(entries => { if (current) setLists(Object.fromEntries(entries)); }, () => {});
    return () => { current = false; };
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
    const parts: string[] = [];
    if (summary.working > 0) parts.push(`${summary.working} running`);
    if (summary.userControlled > 0) parts.push(`${summary.userControlled} in your control`);
    if (parts.length === 0) return null;
    return {
      label: `Subagents · ${parts.join(" · ")}`,
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

/** Header button on a user-controlled worker thread; returns control to the calling agent. */
export const subagentsReturnControlAction: PluginThreadActionRegistration<SubagentsHeaderData> = {
  id: "return-control",
  title: "Return control",
  icon: "UserRound",
  group: "subagents",
  order: 10,
  placement: "header",
  useData: useSubagentsHeaderData,
  item: ({ thread, data, navigate }) => {
    const run = data?.lists[thread.id]?.promoted;
    if (!run || run.control !== "user") return null;
    return {
      label: "Return control",
      icon: "UserRound",
      run: async () => {
        const result = await data.rpc.call("returnControl", { id: run.id });
        navigate.toThread(result.threadId);
      },
    };
  },
};
