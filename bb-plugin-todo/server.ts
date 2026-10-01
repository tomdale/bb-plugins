import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { apply, emptyState, type Input, type State } from "./model.ts";

const id = z.number().int().positive();
const status = z.enum(["pending", "in_progress", "completed", "deleted"]);
const metadata = z.record(z.string(), z.unknown());
const task = z.object({
  id, subject: z.string(), status, description: z.string().optional(), activeForm: z.string().optional(),
  parentId: id.optional(), blockedBy: z.array(id).optional(), owner: z.string().optional(), metadata: metadata.optional(),
});
const stateSchema = z.object({ tasks: z.array(task), nextId: id });
const input = z.object({
  action: z.enum(["create", "update", "get", "list", "delete", "clear"]),
  id: id.optional(), subject: z.string().optional(), description: z.string().optional(),
  activeForm: z.string().optional(), status: status.optional(), parentId: id.nullable().optional(),
  blockedBy: z.array(id).optional(), addBlockedBy: z.array(id).optional(), removeBlockedBy: z.array(id).optional(),
  owner: z.string().optional(), metadata: metadata.optional(), includeDeleted: z.boolean().optional(), move: z.enum(["up", "down"]).optional(),
});
export const rpcContract = defineRpcContract({
  snapshot: { input: z.object({ threadId: z.string().min(1) }), output: stateSchema },
  mutate: { input: z.object({ threadId: z.string().min(1), change: input }), output: stateSchema },
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
  bb.storage.migrate(db, ["CREATE TABLE IF NOT EXISTS todo_threads (thread_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)"]);
  const read = (threadId: string): State => {
    const row = db.prepare("SELECT state_json FROM todo_threads WHERE thread_id = ?").get(threadId) as { state_json: string } | undefined;
    if (!row) return emptyState();
    return stateSchema.parse(JSON.parse(row.state_json));
  };
  const save = db.prepare("INSERT INTO todo_threads(thread_id, state_json) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET state_json = excluded.state_json");
  const mutate = (threadId: string, change: Input) => {
    const result = db.transaction(() => {
      const next = apply(read(threadId), change);
      if (next.changed) save.run(threadId, JSON.stringify(next.state));
      return next;
    })();
    if (result.changed) bb.realtime.publish("todo-changed", { threadId });
    return result;
  };
  bb.rpc.register(rpcContract, {
    snapshot: ({ threadId }) => read(threadId),
    mutate: ({ threadId, change }) => mutate(threadId, change).state,
  });
  bb.agents.registerTool({
    name: "todo", description: "Manage a per-thread task list with parent tasks and blocking dependencies. Actions: create, update, get, list, delete, clear.",
    instructions: "Use todo for work with three or more steps or a user-supplied task list; skip trivial requests. Create a concise list promptly with outcome-oriented subjects; create starts each task pending. Before working on a task, update {id,status:'in_progress',activeForm:'Implementing X'} with a present-tense working label. Keep every task actually being worked on in_progress; multiple tasks may be active for concurrent work. Mark each task completed as soon as its work and checks pass. Keep blocked, queued, and paused work pending; record prerequisites with blockedBy on create and addBlockedBy/removeBlockedBy on update, and satisfy them before starting the task. Use parentId for subtasks; complete a parent only after its required subtasks and checks pass. When a turn ends, unfinished in_progress tasks reset to pending; on continuation call list and mark resumed work in_progress again. The collapsed card shows all active tasks, or the next two pending tasks, so keep statuses and order current. Update {id,move:'up'|'down'} reorders siblings. list returns current tasks in display order, optionally filtered by status, and hides deleted tasks unless includeDeleted is true. Read list after user edits and before resuming prior work. Invalid references and cycles are rejected; completed tasks cannot reopen, delete leaves a tombstone, and clear resets the list and IDs. Preserve unfinished tasks across turns; use clear only when the list is obsolete or the user requests a reset.",
    parameters: input,
    async execute(params: Input, { threadId }) {
      try {
        return mutate(threadId, params).message;
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
  bb.events.on("thread.deleted", ({ thread }) => { db.prepare("DELETE FROM todo_threads WHERE thread_id = ?").run(thread.id); });
  bb.agents.configure(() => ({ tools: ["todo"], skills: [] }));
}
