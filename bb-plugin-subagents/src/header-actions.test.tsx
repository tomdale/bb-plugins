// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BbNavigate, PluginThreadActionTarget } from "@get-bb/plugin-sdk";
import type { ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { subagentsReturnControlAction, subagentsStatusAction } from "./header-actions.ts";
import type { SubagentsHeaderData } from "./header-actions.ts";
import type { Run } from "./contracts.ts";

const run: Run = {
  id: "run", ownerThreadId: "origin", rootThreadId: "origin", threadId: "worker", title: "Review", task: "Review code", depth: 1,
  createdAt: 1, deadline: null, status: "running", control: "agent", output: "", error: null, notifications: [], cleanupPending: false,
};
const thread = { id: "origin" } as PluginThreadActionTarget;
const navigateCalls: string[] = [];
const navigate = { toThread: (id: string) => navigateCalls.push(id) } as unknown as BbNavigate;
const panelCalls: unknown[] = [];
const panel = { openTab: (options: unknown) => { panelCalls.push(options); return true; } } as unknown as ExperimentalPanelController;
const rpcCalls: { method: string; input: unknown }[] = [];
const data = {
  rpc: { call: async (method: string, input: unknown) => { rpcCalls.push({ method, input }); return { threadId: "origin" }; } },
  lists: {} as Record<string, { runs: Run[]; promoted: Run | null }>,
} as unknown as SubagentsHeaderData;
const runInput = { requestRename: () => {} };
const input = { thread, data, sdk: {} as never, navigate, experimental_panel: panel };
const emptyInput = { ...input, data: undefined as unknown as SubagentsHeaderData };

describe("subagentsStatusAction", () => {
  it("is hidden until the thread's list has loaded and hides when nothing is active", () => {
    expect(subagentsStatusAction.item(emptyInput)).toBeNull();
    data.lists[thread.id] = { runs: [{ ...run, status: "completed" }], promoted: null };
    expect(subagentsStatusAction.item(input)).toBeNull();
  });
  it("labels working and user-controlled counts and opens the panel tab", () => {
    data.lists[thread.id] = { runs: [run, { ...run, id: "b", control: "user" }, { ...run, id: "c", status: "completed" }], promoted: null };
    const action = subagentsStatusAction.item(input);
    expect(action).toMatchObject({ label: "Subagents · 1 running · 1 in your control", icon: "Bot" });
    void action!.run!(runInput);
    expect(panelCalls).toEqual([{ tab: { id: "subagents", context: { kind: "thread" }, availability: "action" }, params: { threadId: "origin" } }]);
  });
});

describe("subagentsReturnControlAction", () => {
  it("shows only on the user-controlled worker thread", () => {
    expect(subagentsReturnControlAction.item(emptyInput)).toBeNull();
    data.lists[thread.id] = { runs: [], promoted: { ...run, control: "agent" } };
    expect(subagentsReturnControlAction.item(input)).toBeNull();
    data.lists[thread.id] = { runs: [], promoted: { ...run, control: "user" } };
    expect(subagentsReturnControlAction.item(input)).toMatchObject({ label: "Return control", icon: "UserRound" });
  });
  it("returns control and navigates back to the calling thread", async () => {
    data.lists[thread.id] = { runs: [], promoted: { ...run, control: "user" } };
    const action = subagentsReturnControlAction.item(input);
    await action!.run!(runInput);
    expect(rpcCalls).toEqual([{ method: "returnControl", input: { id: "run" } }]);
    expect(navigateCalls).toEqual(["origin"]);
  });
});
