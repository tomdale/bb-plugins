// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BbNavigate, PluginThreadActionTarget } from "@get-bb/plugin-sdk";
import type { ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { subagentsStatusAction } from "./header-actions.ts";
import type { SubagentsHeaderData } from "./header-actions.ts";
import type { Run } from "./contracts.ts";

const run: Run = {
  id: "run",
  ownerThreadId: "origin",
  rootThreadId: "origin",
  threadId: "worker",
  title: "Review",
  task: "Review code",
  depth: 1,
  providerId: "pi",
  model: "claude-opus-4-6",
  reasoningLevel: "high",
  statusSummary: "Reviewing code.",
  summaryUpdatedAt: 1,
  createdAt: 1,
  deadline: null,
  status: "running",
  control: "agent",
  output: "",
  error: null,
  notifications: [],
  cleanupPending: false,
};
const thread = { id: "origin" } as PluginThreadActionTarget;
const navigate = { toThread: () => {} } as unknown as BbNavigate;
const panelCalls: unknown[] = [];
const panel = {
  openTab: (options: unknown) => {
    panelCalls.push(options);
    return true;
  },
} as unknown as ExperimentalPanelController;
const data = {
  rpc: { call: async () => ({ threadId: "origin" }) },
  lists: {} as Record<string, { runs: Run[] }>,
} as unknown as SubagentsHeaderData;
const runInput = { requestRename: () => {} };
const input = { thread, data, sdk: {} as never, navigate, experimental_panel: panel };
const emptyInput = { ...input, data: undefined as unknown as SubagentsHeaderData };

describe("subagentsStatusAction", () => {
  it("is hidden until the thread's list has loaded and hides when nothing is active", () => {
    expect(subagentsStatusAction.item(emptyInput)).toBeNull();
    data.lists[thread.id] = { runs: [{ ...run, status: "completed" }] };
    expect(subagentsStatusAction.item(input)).toBeNull();
  });
  it("labels working counts and opens the panel tab", () => {
    data.lists[thread.id] = { runs: [run, { ...run, id: "b" }, { ...run, id: "c", status: "completed" }] };
    const action = subagentsStatusAction.item(input);
    expect(action).toMatchObject({ label: "Subagents · 2 running", icon: "Bot" });
    void action!.run!(runInput);
    expect(panelCalls).toEqual([
      { tab: { id: "subagents", context: { kind: "thread" }, availability: "action" }, params: { threadId: "origin" } },
    ]);
  });
});
