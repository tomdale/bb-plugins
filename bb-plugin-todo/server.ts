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

const planStatus = z.enum(["pending", "in_progress", "completed"]);

const setTask = z.object({
  id: id.optional().describe("Local task number within the plan (1, 2, 3...)"),
  subject: z.string().min(1).describe("Outcome-oriented task subject"),
  status: planStatus.optional().describe("Task status ('pending', 'in_progress', 'completed')"),
  activeForm: z.string().optional().describe("Present-tense working label when in progress"),
  description: z.string().optional(),
  parentId: id.nullable().optional().describe("Local ID of parent task for nesting"),
  blockedBy: z.array(id).optional().describe("Local IDs of prerequisite tasks"),
  owner: z.string().optional(),
  metadata: metadata.optional(),
});

const input = z.object({
  action: z.enum(["create", "update", "get", "list", "delete", "clear", "set"]),
  tasks: z.array(setTask).optional().describe("For 'set': complete array of tasks for the active plan. Array order defines sequence."),
  id: id.optional(), subject: z.string().optional(), description: z.string().optional(),
  activeForm: z.string().optional(), status: status.optional(), parentId: id.nullable().optional(),
  blockedBy: z.array(id).optional(), addBlockedBy: z.array(id).optional(), removeBlockedBy: z.array(id).optional(),
  owner: z.string().optional(), metadata: metadata.optional(), includeDeleted: z.boolean().optional(),
  move: z.enum(["up", "down"]).optional().describe("Only pass to reorder a task. Omit when updating status or subject."),
});

const agentStatus = z.enum(["pending", "in_progress", "completed"]);

const agentInput = z.object({
  action: z.enum(["set", "update", "list", "get", "clear"]).describe(
    "Action to perform: 'set' to declare or replace the active plan, 'update' to modify tasks, 'list' to read the active plan, 'get' for task details, 'clear' to reset.",
  ),
  tasks: z.array(setTask).optional().describe("For 'set': complete array of tasks with local IDs (1, 2, 3...). Array order defines sequence."),
  id: id.optional().describe("For 'update' / 'get': local task ID"),
  subject: z.string().optional().describe("For 'update': revised subject"),
  status: agentStatus.optional().describe("For 'update': new status ('pending', 'in_progress', 'completed'); for 'list': optional status filter"),
  activeForm: z.string().optional().describe("Present-tense working label when in progress (e.g. 'Implementing X')"),
  description: z.string().optional().describe("For 'update': task notes"),
  parentId: id.nullable().optional().describe("For 'update': parent task ID for nesting. Pass null to detach to root."),
  blockedBy: z.array(id).optional().describe("For 'update': full replacement of prerequisite task IDs"),
  addBlockedBy: z.array(id).optional().describe("For 'update': prerequisite task IDs to add"),
  removeBlockedBy: z.array(id).optional().describe("For 'update': prerequisite task IDs to remove"),
  owner: z.string().optional(),
  metadata: metadata.optional(),
});

export const rpcContract = defineRpcContract({
  snapshot: { input: z.object({ threadId: z.string().min(1) }), output: stateSchema },
  mutate: { input: z.object({ threadId: z.string().min(1), change: input }), output: stateSchema },
  archiveCompleted: { input: z.object({ threadId: z.string().min(1) }), output: z.object({ archived: z.boolean() }) },
  listArchives: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      archives: z.array(z.object({ id: z.number(), completedAt: z.string(), tasks: z.array(task) })),
    }),
  },
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
    return stateSchema.parse(JSON.parse(row.state_json));
  };
  const save = db.prepare("INSERT INTO todo_threads(thread_id, state_json) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET state_json = excluded.state_json");
  const archivePlan = (threadId: string, tasks: readonly unknown[]) => {
    if (!tasks.length) return;
    db.prepare("INSERT INTO todo_plan_archives (thread_id, plan_json, completed_at) VALUES (?, ?, ?)")
      .run(threadId, JSON.stringify(tasks), new Date().toISOString());
  };
  const mutate = (threadId: string, change: Input) => {
    const result = db.transaction(() => {
      const current = read(threadId);
      if (change.action === "set" && current.tasks.some(t => t.status === "completed")) {
        archivePlan(threadId, current.tasks);
      }
      const next = apply(current, change);
      if (next.changed) save.run(threadId, JSON.stringify(next.state));
      return next;
    })();
    if (result.changed) bb.realtime.publish("todo-changed", { threadId });
    return result;
  };
  bb.rpc.register(rpcContract, {
    snapshot: ({ threadId }) => read(threadId),
    mutate: ({ threadId, change }) => mutate(threadId, change).state,
    archiveCompleted: ({ threadId }) => {
      const changed = db.transaction(() => {
        const current = read(threadId);
        if (!current.tasks.length || !current.tasks.every(t => t.status === "completed" || t.status === "deleted")) {
          return false;
        }
        archivePlan(threadId, current.tasks);
        save.run(threadId, JSON.stringify(emptyState()));
        return true;
      })();
      if (changed) bb.realtime.publish("todo-changed", { threadId });
      return { archived: changed };
    },
    listArchives: ({ threadId }) => {
      const rows = db.prepare("SELECT id, plan_json, completed_at FROM todo_plan_archives WHERE thread_id = ? ORDER BY id DESC")
        .all(threadId) as Array<{ id: number; plan_json: string; completed_at: string }>;
      return {
        archives: rows.map(r => ({
          id: r.id,
          completedAt: r.completed_at,
          tasks: z.array(task).parse(JSON.parse(r.plan_json)),
        })),
      };
    },
  });
  bb.agents.registerTool({
    name: "todo", description: "Manage a per-thread working plan with parent tasks and dependencies. Actions: set, update, list, get, clear.",
    instructions: "Use todo for work with three or more steps or a user-supplied task list; skip trivial requests. Use action 'set' with a tasks array to declare or replace the plan with local IDs (1, 2, 3...). Array order defines task order. Replacing a plan archives the previous plan if any task in it was completed. Before working on a task, update it to {id, status: 'in_progress', activeForm: 'Implementing X'} with a present-tense working label; multiple tasks may be in progress for concurrent work. When finished, mark it completed immediately only after work and checks pass; completed tasks cannot reopen. Keep blocked, queued, and paused work pending, and satisfy blockedBy prerequisites before starting a task. Use parentId for subtasks, and complete a parent only after its required subtasks and checks pass. Update adds or removes prerequisite edges with addBlockedBy/removeBlockedBy. Invalid parentId or blockedBy references and cycles are rejected. Unfinished in-progress tasks reset to pending at turn end. After user/UI edits and on continuation, call 'list' before updating or resuming tasks, then mark resumed work in_progress again. Keep statuses current so the collapsed card reflects active work and completion accurately. list returns current tasks in display order, optionally filtered by status. Use 'clear' only when the plan is obsolete or the user requests a reset, because it clears the plan and resets local IDs.",
    parameters: agentInput,
    async execute(params: z.infer<typeof agentInput>, { threadId }) {
      try {
        return mutate(threadId, params as Input).message;
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
