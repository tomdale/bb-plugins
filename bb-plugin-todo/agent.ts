/**
 * The agent-facing `todo` contract: four optional lists named `tasks`, `add`, `done`, and `start`.
 *
 * Models fill in every field of a schema, sending `""`, `[]`, `{}` or `null`
 * for the ones they do not mean. The argument schema therefore treats every
 * blank value as absent, so a call can only do what its non-blank fields say.
 * Unknown fields are rejected rather than ignored, so a call is applied whole
 * or not at all.
 *
 * Each call compiles to reducer changes in `model.ts`, the same reducer the
 * Todos panel uses, and answers with the resulting plan so the agent never
 * needs a separate read.
 */
import { z } from "zod";
import { apply, ordered, type Input, type Outcome, type State, type Task } from "./model.ts";

const blank = (value: unknown): boolean =>
  value == null || (typeof value === "string" && !value.trim()) || (typeof value === "object" && Object.keys(value).length === 0);

/** An optional list that also accepts one bare item and drops blank items. */
const list = <T extends z.ZodType>(item: T, description: string) => z.preprocess(value => {
  const items = (Array.isArray(value) ? value : [value]).filter(entry => !blank(entry));
  return items.length > 0 ? items : undefined;
}, z.array(item).optional().describe(description));

export const agentInput = z.strictObject({
  tasks: list(z.string().trim(), "Replace the plan with these task subjects, in order. The first task starts. A replaced plan with completed work is archived."),
  add: list(z.string().trim(), "Append these task subjects to the plan."),
  done: list(z.coerce.number().int().positive(), "Task ids to complete. The next unblocked pending task starts when none is in progress."),
  start: list(z.coerce.number().int().positive(), "Task ids to mark in progress, for parallel work or work resumed after a turn ended."),
});
export type AgentCall = z.output<typeof agentInput>;

const glyph = (task: Task) => task.status === "completed" ? "✓" : task.status === "in_progress" ? "▶" : "○";

/** The plan as the agent reads it: ids, statuses, and unfinished blockers. */
export function renderPlan(state: State): string {
  const rows = ordered(state);
  if (rows.length === 0) return "No tasks";
  const open = new Set(rows.filter(task => task.status !== "completed").map(task => task.id));
  const lines = rows.map(task => {
    const waiting = task.status === "pending" ? (task.blockedBy ?? []).filter(id => open.has(id)) : [];
    return `${glyph(task)} ${task.id} ${task.subject}${waiting.length ? ` (waits on ${waiting.map(id => `#${id}`).join(", ")})` : ""}`;
  });
  return [`Plan ${rows.length - open.size}/${rows.length} done`, ...lines].join("\n");
}

/**
 * Applies one agent call in the order tasks, add, done, start. When a call
 * completes a task or adds one and leaves nothing in progress, the first
 * pending task without unfinished blockers starts. Unknown ids are reported
 * and the rest of the call still applies.
 */
export function applyAgentCall(state: State, call: AgentCall): Outcome {
  const { tasks, add, done, start } = call;
  const notes: string[] = [];

  let next = state;
  const run = (change: Input) => { next = apply(next, change).state; };
  const find = (id: number) => next.tasks.find(task => task.id === id && task.status !== "deleted");
  const setPlan = (subjects: string[]) => run({
    action: "set",
    tasks: subjects.map((subject, index) => ({ subject, status: index === 0 ? "in_progress" : "pending" })),
  });

  if (tasks) setPlan(tasks);
  if (add) {
    if (ordered(next).length === 0) setPlan(add);
    else for (const subject of add) run({ action: "create", subject });
  }
  const missing: number[] = [];
  let completed = false;
  for (const id of new Set(done)) {
    const task = find(id);
    if (!task) missing.push(id);
    else if (task.status !== "completed") { run({ action: "update", id, status: "completed" }); completed = true; }
  }
  for (const id of new Set(start)) {
    const task = find(id);
    if (!task) missing.push(id);
    else if (task.status === "completed") notes.push(`#${id} is already completed`);
    else if (task.status === "pending") run({ action: "update", id, status: "in_progress" });
  }
  if (missing.length) notes.push(`No task ${missing.map(id => `#${id}`).join(", ")}`);

  if ((completed || add) && !next.tasks.some(task => task.status === "in_progress")) {
    const open = new Set(next.tasks.filter(task => task.status === "pending" || task.status === "in_progress").map(task => task.id));
    const upcoming = ordered(next, "pending").find(task => !task.blockedBy?.some(id => open.has(id)));
    if (upcoming) run({ action: "update", id: upcoming.id, status: "in_progress" });
  }

  const changed = JSON.stringify(next) !== JSON.stringify(state);
  return { state: next, message: [...notes, renderPlan(next)].join("\n"), changed };
}
