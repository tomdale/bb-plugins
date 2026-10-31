import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

export const THREAD = "thr_user";
export const WORKER = "thr_worker";

export async function setup(options: { forkFails?: boolean; readCode?: () => unknown; hostRpc?: (call: { method: string; input: any }) => unknown; turnStatus?: () => string | undefined; sendError?: () => Error | null; userTurns?: () => Array<{ seq: number; type: string; data: unknown }>; agentText?: () => string | null; deltas?: () => Array<{ seq: number; itemId: string; delta: string }>; tabs?: { get: (args: { threadId: string }) => unknown; update: (args: { threadId: string; expectedRevision: number; tabs: any[] }) => unknown } } = {}) {
  const sent: Array<{ threadId: string; text: string }> = [];
  const writes: Array<{ path: string; content: string }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "walkthrough",
    experimental_hostEntry: true,
    experimental_callHostRpc: (call) => (options.hostRpc ? options.hostRpc(call as { method: string; input: any }) : options.readCode?.()),
    sdk: {
      threads: {
        get: async (args: { threadId: string }) => makeThreadResponse({ id: args.threadId, environmentId: "env_1", status: "idle" }),
        fork: async () => {
          if (options.forkFails) throw new Error("fork unsupported");
          return makeThreadResponse({ id: WORKER, visibility: "hidden" });
        },
        spawn: async () => makeThreadResponse({ id: WORKER, visibility: "hidden" }),
        send: async (args) => {
          const failure = options.sendError?.();
          if (failure) throw failure;
          const first = args.input[0];
          sent.push({ threadId: args.threadId, text: first && "text" in first ? first.text : "" });
          return {} as never;
        },
        stop: async () => ({}) as never,
        archive: async () => ({}) as never,
        events: {
          list: async (args: { types?: readonly string[]; afterSeq?: string }) =>
            (args.types?.includes("turn/completed")
              ? [{ seq: 99, type: "turn/completed", data: { status: options.turnStatus?.() } }]
              : args.types?.includes("client/turn/requested")
                ? (options.userTurns?.() ?? [])
                : args.types?.includes("item/agentMessage/delta")
                  ? options.deltas
                    ? options.deltas().filter((row) => row.seq > Number(args.afterSeq ?? 0)).slice(0, 100).map((row) => ({ seq: row.seq, type: "item/agentMessage/delta", data: { itemId: row.itemId, delta: row.delta } }))
                    : (options.agentText?.() ?? null) === null ? [] : [{ seq: 100, type: "item/agentMessage/delta", data: { itemId: "i1", delta: options.agentText!() } }]
                  : []) as never,
        },
        queuedMessages: { list: async () => [] as never, send: async () => ({}) as never },
        ...(options.tabs ? { tabs: options.tabs as never } : {}),
      },
      environments: {
        get: async () => ({ id: "env_1", hostId: "host_1", path: "/work/repo" }) as never,
      },
      files: {
        write: async (args: { path: string; content: string }) => {
          writes.push({ path: args.path, content: args.content });
          return { outcome: "written", sha256: "x", sizeBytes: args.content.length } as never;
        },
      },
    },
  });
  await plugin(bb);
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const tool = (name: string, input: unknown, threadId = WORKER) => harness.behavior.callAgentTool(name, input, { threadId });
  const idle = (text: string) =>
    harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: WORKER, status: "idle" }),
      lastAssistantText: text,
    });
  const view = async (id: string) => (await rpc("get", { walkthroughId: id })).view;
  return { bb, harness, rpc, tool, idle, view, sent, writes };
}

export async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

export const PLAN = {
  mode: "local",
  title: "Read aloud plugin",
  baseRef: "origin/main",
  introduction: "Before this branch there was no speech.",
  parts: [
    { title: "Keeping speech requests small", summary: "Bounds", locations: [{ path: "tts.ts", startLine: 1, endLine: 40 }] },
    { title: "Choosing whose key pays", summary: "Keys" },
    { title: "The player", summary: "UI" },
  ],
};

export const PART = {
  part: 1,
  blocks: [
    { kind: "prose", text: "Before, nothing. Now [the cap](line:3) bounds it." },
    { kind: "code", caption: "The cap, in tts.ts", path: "tts.ts", startLine: 1, endLine: 10, notes: [{ line: 3, text: "Truncates." }] },
  ],
  suggestions: ["Why 4,000?"],
};
