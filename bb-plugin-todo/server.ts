import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { apply, initialState, inputSchema, taskSchema, type Input, type State } from "./model.ts";

const threadIdSchema = z.string().min(1).max(256);
const outputSchema = z.object({ tasks: z.array(taskSchema), nextId: z.number().int(), result: z.unknown() });
export const rpcContract = defineRpcContract({
  todos_list: { input: z.object({ threadId: threadIdSchema, includeDeleted: z.boolean().optional() }), output: outputSchema },
  todos_mutate: { input: z.object({ threadId: threadIdSchema, input: inputSchema }), output: outputSchema },
});
const CHANGED = "todos-changed";

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, ["CREATE TABLE IF NOT EXISTS todo_threads (thread_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)"]);
  const get = db.prepare("SELECT state_json FROM todo_threads WHERE thread_id = ?");
  const put = db.prepare("INSERT INTO todo_threads (thread_id, state_json) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET state_json = excluded.state_json");
  const read = (threadId: string): State => {
    const row = get.get(threadId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as State : initialState();
  };
  const execute = db.transaction((threadId: string, input: Input) => {
    const { state, result } = apply(read(threadId), input);
    if (!["list", "get"].includes(input.action)) put.run(threadId, JSON.stringify(state));
    return { tasks: state.tasks, nextId: state.nextId, result };
  });
  const act = (threadId: string, input: Input) => {
    const output = execute(threadId, input);
    if (!["list", "get"].includes(input.action)) bb.realtime.publish(CHANGED, { threadId });
    return output;
  };
  bb.rpc.register(rpcContract, {
    todos_list: ({ threadId, includeDeleted }) => act(threadId, { action: "list", includeDeleted }),
    todos_mutate: ({ threadId, input }) => act(threadId, input),
  });
  bb.agents.registerTool({
    name: "todo", description: "Manage structured per-thread todos. Actions: create, update, list, get, delete. parentId defines hierarchy; blockedBy defines prerequisite IDs. Exactly one task may be in_progress. Completed/deleted tasks cannot reopen.",
    parameters: inputSchema,
    execute(input, ctx) {
      const { result, tasks } = act(ctx.threadId, input);
      return JSON.stringify({ result, tasks: input.action === "list" ? undefined : tasks.filter(t => t.status === "pending" || t.status === "in_progress") });
    },
  });
  bb.cli.register({
    name: "todo", summary: "Manage structured todos for a BB thread",
    commands: [{ name: "run", summary: "Run a todo action from JSON", usage: "bb todo run '<JSON>' [--thread <thread-id>]" }],
    async run(argv, ctx) {
      if (argv[0] === "--help" || argv.length === 0) return { exitCode: 0, stdout: "bb todo run '<JSON>' [--thread <thread-id>] (uses current thread when available)" };
      try {
        if (argv[0] !== "run") throw new Error("Expected run");
        const flags = argv.filter(arg => arg === "--thread");
        const flag = argv.indexOf("--thread");
        if (flags.length > 1 || (flag >= 0 && (flag !== 2 || argv.length !== 4)) || (flag < 0 && argv.length !== 2)) throw new Error("Usage: bb todo run '<JSON>' [--thread <thread-id>]");
        const threadId = flag < 0 ? ctx.threadId : argv[flag + 1];
        if (!threadId) throw new Error("Pass --thread <thread-id> outside a thread");
        threadIdSchema.parse(threadId);
        const input = inputSchema.parse(JSON.parse(argv[1] ?? ""));
        return { exitCode: 0, stdout: JSON.stringify(act(threadId, input)) };
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
    },
  });
}
