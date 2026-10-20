import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentInput, applyAgentCall } from "./agent.ts";
import { emptyState, type State } from "./model.ts";

const id = z.number().int().positive();
const task = z.object({
  id, subject: z.string(), status: z.enum(["pending", "in_progress", "completed"]), parentId: id.optional(),
});
const stateSchema = z.object({ tasks: z.array(task), nextId: id });

export const rpcContract = defineRpcContract({
  snapshot: { input: z.object({ threadId: z.string().min(1) }), output: stateSchema },
  archiveCompleted: { input: z.object({ threadId: z.string().min(1) }), output: z.object({ archived: z.boolean() }) },
});

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    completedHideDelaySeconds: {
      type: "number", label: "Hide completed Todo card after (seconds)",
      description: "Time to show an all-complete list before hiding it. Set to 0 to hide immediately.",
      default: 30, experimental_schema: z.number().int().min(0).max(3600),
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS todo_threads (thread_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS todo_plan_archives (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, plan_json TEXT NOT NULL, completed_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_todo_plan_archives_thread ON todo_plan_archives (thread_id)",
  ]);
  const read = (threadId: string): State => {
    const row = db.prepare("SELECT state_json FROM todo_threads WHERE thread_id = ?").get(threadId) as { state_json: string } | undefined;
    if (!row) return emptyState();
    const stored = JSON.parse(row.state_json) as { tasks?: Array<{ status?: string }> };
    // Plans saved while tasks could be deleted keep their deleted entries.
    return stateSchema.parse({ ...stored, tasks: (stored.tasks ?? []).filter(task => task.status !== "deleted") });
  };
  const save = db.prepare("INSERT INTO todo_threads(thread_id, state_json) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET state_json = excluded.state_json");
  const archivePlan = (threadId: string, tasks: readonly unknown[]) => {
    if (!tasks.length) return;
    db.prepare("INSERT INTO todo_plan_archives (thread_id, plan_json, completed_at) VALUES (?, ?, ?)")
      .run(threadId, JSON.stringify(tasks), new Date().toISOString());
  };
  /** Runs one change against a thread's plan; `replacesPlan` archives a plan that has completed work first. */
  const transact = <T extends { state: State; changed: boolean }>(threadId: string, produce: (current: State) => T, replacesPlan: boolean): T => {
    const result = db.transaction(() => {
      const current = read(threadId);
      if (replacesPlan && current.tasks.some(t => t.status === "completed")) archivePlan(threadId, current.tasks);
      const next = produce(current);
      if (next.changed) save.run(threadId, JSON.stringify(next.state));
      return next;
    })();
    if (result.changed) bb.realtime.publish("todo-changed", { threadId });
    return result;
  };
  bb.rpc.register(rpcContract, {
    snapshot: ({ threadId }) => read(threadId),
    archiveCompleted: ({ threadId }) => {
      const changed = db.transaction(() => {
        const current = read(threadId);
        if (!current.tasks.length || !current.tasks.every(t => t.status === "completed")) return false;
        archivePlan(threadId, current.tasks);
        save.run(threadId, JSON.stringify(emptyState()));
        return true;
      })();
      if (changed) bb.realtime.publish("todo-changed", { threadId });
      return { archived: changed };
    },
  });
  bb.agents.registerTool({
    name: "todo", description: "Track a checklist for multi-step work with tasks, add, done, and start; a successful call returns the plan.",
    instructions: "Use todo for work with three or more steps or a user-supplied task list; skip trivial requests. Declare the plan once with todo({tasks:[\"Inspect X\",\"Fix Y\",\"Verify\"]}); task 1 starts. When a task is done and verified, todo({done:[1]}) completes it and, when nothing else is in progress, starts the next pending task. add appends tasks, including follow-up work, since completed tasks stay completed; with under:[N] the added tasks become subtasks of task N; complete task N with done after its subtasks. start marks parallel work, or work resumed in a later turn because turn end returns in-progress tasks to pending. Send todo alongside your next action rather than alone, so it costs no extra turn. Each successful call returns the current plan with ids; an unknown id is reported alongside it.",
    parameters: agentInput,
    async execute(params, { threadId }) {
      try {
        return transact(threadId, current => applyAgentCall(current, params), params.tasks !== undefined).message;
      } catch (error) {
        return { content: [{ type: "text", text: `Todo: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });
  bb.events.on("thread.active", ({ thread }) => bb.realtime.publish("todo-changed", { threadId: thread.id }));
  const settle = (threadId: string) => {
    const changed = db.transaction(() => {
      const current = read(threadId);
      if (!current.tasks.some(task => task.status === "in_progress")) return false;
      const tasks = current.tasks.map(task => task.status === "in_progress" ? { ...task, status: "pending" as const } : task);
      save.run(threadId, JSON.stringify({ ...current, tasks }));
      return true;
    })();
    if (changed) bb.realtime.publish("todo-changed", { threadId });
  };
  bb.events.on("thread.idle", ({ thread }) => settle(thread.id));
  bb.events.on("thread.failed", ({ thread }) => settle(thread.id));
  bb.events.on("thread.archived", ({ thread }) => settle(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => {
    db.prepare("DELETE FROM todo_threads WHERE thread_id = ?").run(thread.id);
    db.prepare("DELETE FROM todo_plan_archives WHERE thread_id = ?").run(thread.id);
  });
  bb.agents.configure(() => ({ tools: ["todo"], skills: [] }));
}
