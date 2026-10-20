/**
 * The agent-facing `todo` contract: the optional fields `tasks`, `add`, `under`, `done`, and `start`.
 *
 * Models fill in every field of a schema, sending `""`, `[]`, `{}` or `null`
 * for the ones they do not mean. The argument schema therefore treats every
 * blank value as absent, so a call can only do what its non-blank fields say.
 * Unknown fields are rejected rather than ignored, so a call is applied whole
 * or not at all.
 *
 * Each call answers with the resulting plan, so the agent never needs a
 * separate read.
 */
import { z } from "zod";
import { addTask, newPlan, ordered, setStatus, type State, type Task } from "./model.ts";

const blank = (value: unknown): boolean =>
  value == null || (typeof value === "string" && !value.trim()) || (typeof value === "object" && Object.keys(value).length === 0);

/**
 * An optional list that also accepts one bare item and drops blank items.
 * Every field is a list so that a model filling in all of them has one empty
 * value, `[]`, for "not used" and never needs to invent an id or a subject.
 */
const list = <T extends z.ZodType>(item: T, description: string, max?: number) => z.preprocess(value => {
  const items = (Array.isArray(value) ? value : [value]).filter(entry => !blank(entry));
  return items.length > 0 ? items : undefined;
}, (max === undefined ? z.array(item) : z.array(item).max(max)).optional().describe(description));

export const agentInput = z.strictObject({
  tasks: list(z.string().trim(), "Replace the plan with these task subjects, in order. The first task starts. A replaced plan with completed work is archived."),
  add: list(z.string().trim(), "Append these task subjects to the plan."),
  under: list(z.coerce.number().int().positive(), "With add: [id] of the task the added tasks are subtasks of.", 1),
  done: list(z.coerce.number().int().positive(), "Task ids to complete. The next pending task starts when none is in progress."),
  start: list(z.coerce.number().int().positive(), "Task ids to mark in progress, for parallel work or work resumed after a turn ended."),
});
export type AgentCall = z.output<typeof agentInput>;

const glyph = (task: Task) => task.status === "completed" ? "✓" : task.status === "in_progress" ? "▶" : "○";

/** The plan as the agent reads it: ids, statuses, and nesting. */
export function renderPlan(state: State): string {
  const rows = ordered(state.tasks);
  if (rows.length === 0) return "No tasks";
  const depths = new Map<number, number>();
  const lines = rows.map(task => {
    const depth = task.parentId !== undefined && depths.has(task.parentId) ? depths.get(task.parentId)! + 1 : 0;
    depths.set(task.id, depth);
    return `${"  ".repeat(depth)}${glyph(task)} ${task.id} ${task.subject}`;
  });
  const completed = rows.filter(task => task.status === "completed").length;
  return [`Plan ${completed}/${rows.length} done`, ...lines].join("\n");
}

/**
 * Applies one agent call in the order tasks, add, done, start. When a call
 * completes a task or adds one and leaves nothing being worked on, the first
 * pending task in display order starts. Unknown ids are reported and the rest
 * of the call still applies; an unknown `under` skips the add so tasks are
 * never placed somewhere the agent did not name.
 */
export function applyAgentCall(state: State, call: AgentCall): { state: State; message: string; changed: boolean } {
  const { tasks, add, done, start } = call;
  const parent = call.under?.[0];
  const notes: string[] = [];

  let next = state;
  const find = (id: number) => next.tasks.find(task => task.id === id);

  const missing: number[] = [];
  if (tasks) next = newPlan(tasks);
  let added = false;
  if (add) {
    if (parent !== undefined && !find(parent)) missing.push(parent);
    else {
      if (next.tasks.length === 0) next = newPlan(add);
      else for (const subject of add) next = addTask(next, subject, parent);
      added = true;
    }
  } else if (parent !== undefined) notes.push("under applies to add");
  let completed = false;
  for (const id of new Set(done)) {
    const task = find(id);
    if (!task) missing.push(id);
    else if (task.status !== "completed") { next = setStatus(next, id, "completed"); completed = true; }
  }
  for (const id of new Set(start)) {
    const task = find(id);
    if (!task) missing.push(id);
    else if (task.status === "completed") notes.push(`#${id} is already completed`);
    else next = setStatus(next, id, "in_progress");
  }
  if (missing.length) notes.push(`No task ${missing.map(id => `#${id}`).join(", ")}`);

  // A parent with unfinished subtasks is waiting on them, not being worked on.
  const unfinished = next.tasks.filter(task => task.status !== "completed");
  const parents = new Set(unfinished.map(task => task.parentId));
  if ((completed || added) && !unfinished.some(task => task.status === "in_progress" && !parents.has(task.id))) {
    const upcoming = ordered(next.tasks).find(task => task.status === "pending");
    if (upcoming) next = setStatus(next, upcoming.id, "in_progress");
  }

  const changed = JSON.stringify(next) !== JSON.stringify(state);
  return { state: next, message: [...notes, renderPlan(next)].join("\n"), changed };
}
