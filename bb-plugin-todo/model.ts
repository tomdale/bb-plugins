export type Status = "pending" | "in_progress" | "completed" | "deleted";
export interface Task {
  id: number;
  subject: string;
  status: Status;
  description?: string;
  activeForm?: string;
  parentId?: number;
  blockedBy?: number[];
  owner?: string;
}
export interface State { tasks: Task[]; nextId: number }
export type Call = Record<string, unknown>;
export const emptyState = (): State => ({ tasks: [], nextId: 1 });
const statuses: readonly string[] = ["pending", "in_progress", "completed", "deleted"];
const transitions: Record<Status, readonly Status[]> = {
  pending: ["pending", "in_progress", "completed", "deleted"],
  in_progress: ["pending", "in_progress", "completed", "deleted"],
  completed: ["completed", "deleted"], deleted: ["deleted"],
};
const record = (v: unknown): v is Call => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const status = (v: unknown): v is Status => typeof v === "string" && statuses.includes(v);

function patch(state: State, call: Call): State | null {
  if (call.action === "create") {
    if (typeof call.subject !== "string" || !call.subject.trim()) return null;
    const nextStatus = call.status === undefined ? "pending" : call.status;
    if (nextStatus !== "pending" && nextStatus !== "in_progress") return null;
    const task: Task = { id: state.nextId, subject: call.subject, status: nextStatus };
    for (const field of ["description", "activeForm", "owner"] as const) {
      if (call[field] !== undefined) {
        if (typeof call[field] !== "string") return null;
        task[field] = call[field];
      }
    }
    // Current pi-todo ignores these fields. Keep them when another installed
    // producer actually emits them; never infer hierarchy from task text.
    if (call.parentId !== undefined && call.parentId !== null) {
      if (!id(call.parentId)) return null;
      task.parentId = call.parentId;
    }
    if (call.blockedBy !== undefined) {
      if (!Array.isArray(call.blockedBy) || !call.blockedBy.every(id)) return null;
      task.blockedBy = [...call.blockedBy];
    }
    if (task.status === "in_progress" && state.tasks.some(other => other.status === "in_progress")) return null;
    return { tasks: [...state.tasks, task], nextId: state.nextId + 1 };
  }
  if (call.action !== "update" && call.action !== "delete") return null;
  if (!id(call.id)) return null;
  const index = state.tasks.findIndex(task => task.id === call.id);
  if (index < 0) return null;
  const old = state.tasks[index]!;
  if (call.action === "delete" && old.status === "deleted") return null;
  const updated: Task = { ...old };
  if (call.action === "delete") updated.status = "deleted";
  else {
    const fields = ["subject", "description", "activeForm", "owner", "status", "parentId", "addBlockedBy", "removeBlockedBy", "metadata"];
    if (!fields.some(field => call[field] !== undefined)) return null;
    if (call.status !== undefined) {
      if (!status(call.status) || !transitions[old.status].includes(call.status)) return null;
      updated.status = call.status;
    }
    for (const field of ["subject", "description", "activeForm", "owner"] as const) {
      if (call[field] !== undefined) {
        if (typeof call[field] !== "string" || field === "subject" && !call[field].trim()) return null;
        updated[field] = call[field];
      }
    }
    if (call.parentId === null) delete updated.parentId;
    else if (call.parentId !== undefined) {
      if (!id(call.parentId)) return null;
      updated.parentId = call.parentId;
    }
    for (const field of ["addBlockedBy", "removeBlockedBy"] as const) {
      if (call[field] !== undefined && (!Array.isArray(call[field]) || !call[field].every(id))) return null;
    }
    if (call.addBlockedBy || call.removeBlockedBy) {
      updated.blockedBy = [...new Set([...(old.blockedBy ?? []), ...((call.addBlockedBy as number[] | undefined) ?? [])])]
        .filter(dependency => !((call.removeBlockedBy as number[] | undefined) ?? []).includes(dependency));
    }
  }
  if (updated.status === "in_progress" && state.tasks.some(task => task.id !== updated.id && task.status === "in_progress")) return null;
  const tasks = [...state.tasks]; tasks[index] = updated;
  return { ...state, tasks };
}

// A completed BB tool call is the commit boundary; apply batches atomically.
// Pi's multi-item fresh cycle rolls over only on a successful qualifying batch.
export function replayCall(state: State, call: Call): State {
  if (call.action === "list" || call.action === "get") return state;
  if (call.action !== "batch") {
    if (call.action === "create" && (state.tasks.length === 0 || state.tasks.every(task => task.status === "completed" || task.status === "deleted"))) return state;
    return patch(state, call) ?? state;
  }
  if (!Array.isArray(call.operations) || call.operations.length === 0 || call.operations.length > 50) return state;
  let next = state;
  const creates = call.operations.filter((op: unknown) => record(op) && op.action === "create").length;
  const terminal = state.tasks.length === 0 || state.tasks.every(task => task.status === "completed" || task.status === "deleted");
  if (terminal && creates < 2) return state;
  if (state.tasks.length > 0 && terminal) next = { tasks: [], nextId: state.nextId };
  for (const op of call.operations) {
    if (!record(op) || !["create", "update", "delete"].includes(String(op.action))) return state;
    const applied = patch(next, op);
    if (!applied) return state;
    next = applied;
  }
  return next;
}
export function replayCalls(calls: readonly Call[]): State {
  return calls.reduce(replayCall, emptyState());
}
