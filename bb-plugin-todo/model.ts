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
  metadata?: Record<string, unknown>;
}
export interface State { tasks: Task[]; nextId: number }
export type Action = "create" | "update" | "get" | "list" | "delete" | "clear" | "set";
export type PlanStatus = "pending" | "in_progress" | "completed";
export interface SetTaskInput {
  id?: number;
  subject: string;
  status?: PlanStatus;
  description?: string;
  activeForm?: string;
  parentId?: number | null;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}
export interface Input {
  action: Action;
  id?: number;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: Status;
  parentId?: number | null;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  includeDeleted?: boolean;
  move?: "up" | "down";
  tasks?: SetTaskInput[];
}
export const emptyState = (): State => ({ tasks: [], nextId: 1 });
export type Outcome = { state: State; message: string; changed: boolean };
const transitions: Record<Status, readonly Status[]> = {
  pending: ["pending", "in_progress", "completed", "deleted"],
  in_progress: ["in_progress", "pending", "completed", "deleted"],
  completed: ["completed", "deleted"], deleted: ["deleted"],
};
function fail(message: string): never { throw new Error(message); }
const taskById = (state: State, id: number) => state.tasks.find(task => task.id === id);
const reference = (state: State, id: number, field: string): Task => {
  const task = taskById(state, id);
  if (!task) return fail(`${field}: #${id} not found`);
  if (task.status === "deleted") return fail(`${field}: #${id} is deleted`);
  return task;
};
function checkParent(state: State, id: number, parentId: number): void {
  if (id === parentId) fail(`cannot make #${id} its own parent`);
  reference(state, parentId, "parentId");
  const seen = new Set([id]);
  for (let cursor: number | undefined = parentId; cursor !== undefined; cursor = taskById(state, cursor)?.parentId) {
    if (seen.has(cursor)) fail("parentId would create a cycle");
    seen.add(cursor);
  }
}
function checkDependencies(state: State, id: number, deps: number[], field: string): void {
  for (const dep of deps) {
    if (dep === id) fail(`cannot block #${id} on itself`);
    reference(state, dep, field);
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (node: number): boolean => {
    if (node === id || visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    if ((taskById(state, node)?.blockedBy ?? []).some(visit)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  if (deps.some(visit)) fail(`${field} would create a cycle in the blockedBy graph`);
}
function ordered(state: State, status?: Status, includeDeleted = false): Task[] {
  const visible = state.tasks.filter(task => (includeDeleted || task.status !== "deleted") && (!status || task.status === status));
  const ids = new Set(visible.map(task => task.id));
  const result: Task[] = [];
  const visit = (parentId?: number) => {
    for (const task of visible) if ((ids.has(task.parentId!) ? task.parentId : undefined) === parentId) {
      result.push(task);
      visit(task.id);
    }
  };
  visit();
  return result;
}
export function apply(state: State, input: Input): Outcome {
  const { action } = input;
  if (action === "list") {
    const tasks = ordered(state, input.status, input.includeDeleted);
    return { state, message: tasks.length ? JSON.stringify(tasks) : "No tasks", changed: false };
  }
  if (action === "get") {
    if (input.id === undefined) fail("id required for get");
    const task = taskById(state, input.id);
    if (!task) fail(`#${input.id} not found`);
    const blocks = state.tasks.filter(other => other.blockedBy?.includes(task.id)).map(other => other.id);
    return { state, message: JSON.stringify({ ...task, blocks }), changed: false };
  }
  if (action === "clear") return { state: emptyState(), message: `Cleared ${state.tasks.length} tasks`, changed: state.tasks.length > 0 || state.nextId !== 1 };
  if (action === "set") {
    const inputTasks = input.tasks ?? [];
    if (inputTasks.length === 0) return { state: emptyState(), message: "Cleared plan", changed: state.tasks.length > 0 || state.nextId !== 1 };
    const idMap = new Map<number, number>();
    inputTasks.forEach((t, index) => { if (t.id !== undefined) idMap.set(t.id, index + 1); });
    const newTasks: Task[] = [];
    for (let i = 0; i < inputTasks.length; i++) {
      const t = inputTasks[i]!;
      if (!t.subject?.trim()) fail(`task at index ${i} requires subject`);
      const newId = i + 1;
      const resolvedParentId = t.parentId != null ? (idMap.get(t.parentId) ?? t.parentId) : undefined;
      const resolvedBlockedBy = t.blockedBy?.map(b => idMap.get(b) ?? b);
      const taskObj: Task = { id: newId, subject: t.subject.trim(), status: t.status ?? "pending" };
      if (t.description !== undefined) taskObj.description = t.description;
      if (t.activeForm !== undefined) taskObj.activeForm = t.activeForm;
      if (t.owner !== undefined) taskObj.owner = t.owner;
      if (t.metadata !== undefined) taskObj.metadata = t.metadata;
      if (resolvedParentId !== undefined) taskObj.parentId = resolvedParentId;
      if (resolvedBlockedBy && resolvedBlockedBy.length > 0) taskObj.blockedBy = [...new Set(resolvedBlockedBy)];
      newTasks.push(taskObj);
    }
    const testState: State = { tasks: newTasks, nextId: newTasks.length + 1 };
    for (const t of newTasks) {
      if (t.parentId !== undefined) checkParent(testState, t.id, t.parentId);
      if (t.blockedBy && t.blockedBy.length > 0) checkDependencies(testState, t.id, t.blockedBy, `task #${t.id} blockedBy`);
    }
    return { state: testState, message: `Set plan with ${newTasks.length} tasks`, changed: true };
  }
  if (action === "create") {
    if (!input.subject?.trim()) fail("subject required for create");
    const id = state.nextId;
    if (input.parentId != null) checkParent(state, id, input.parentId);
    if (input.blockedBy?.length) checkDependencies(state, id, input.blockedBy, "blockedBy");
    const task: Task = { id, subject: input.subject, status: "pending" };
    for (const key of ["description", "activeForm", "owner", "metadata"] as const) {
      if (input[key] !== undefined) Object.assign(task, { [key]: input[key] });
    }
    if (input.parentId != null) task.parentId = input.parentId;
    if (input.blockedBy?.length) task.blockedBy = [...new Set(input.blockedBy)];
    return { state: { tasks: [...state.tasks, task], nextId: id + 1 }, message: `Created #${id}: ${task.subject}`, changed: true };
  }
  if (input.id === undefined) fail(`id required for ${action}`);
  const current = taskById(state, input.id);
  if (!current) fail(`#${input.id} not found`);
  if (action === "delete") {
    if (current.status === "deleted") fail(`#${input.id} is already deleted`);
    const tasks = state.tasks.map(task => task.id === input.id ? { ...task, status: "deleted" as const } : task);
    return { state: { ...state, tasks }, message: `Deleted #${input.id}`, changed: true };
  }
  if (action !== "update") return fail(`Unknown action: ${action}`);
  if (input.subject === undefined && input.description === undefined && input.activeForm === undefined && input.status === undefined && input.parentId === undefined && input.owner === undefined && input.metadata === undefined && !input.addBlockedBy?.length && !input.removeBlockedBy?.length && !input.move) fail("update requires at least one mutable field");
  if (input.status && !transitions[current.status].includes(input.status)) fail(`illegal transition ${current.status} → ${input.status}`);
  if (input.parentId != null) checkParent(state, current.id, input.parentId);
  const deps = [...new Set([...(current.blockedBy ?? []).filter(id => !input.removeBlockedBy?.includes(id)), ...(input.addBlockedBy ?? [])])];
  if (input.addBlockedBy?.length) checkDependencies(state, current.id, deps, "addBlockedBy");
  const updated: Task = { ...current };
  for (const key of ["subject", "description", "activeForm", "owner", "status"] as const) {
    if (input[key] !== undefined) Object.assign(updated, { [key]: input[key] });
  }
  if (input.subject !== undefined && !input.subject.trim()) fail("subject cannot be empty");
  if (input.parentId === null) delete updated.parentId;
  else if (input.parentId !== undefined) updated.parentId = input.parentId;
  if (deps.length) updated.blockedBy = deps;
  else delete updated.blockedBy;
  if (input.metadata) {
    const metadata = { ...current.metadata, ...input.metadata };
    for (const [key, value] of Object.entries(metadata)) if (value === null) delete metadata[key];
    if (Object.keys(metadata).length) updated.metadata = metadata;
    else delete updated.metadata;
  }
  const tasks = state.tasks.map(task => task.id === updated.id ? updated : task);
  if (input.move) {
    const visible = ordered({ ...state, tasks });
    const siblings = visible.filter(task => task.parentId === updated.parentId);
    const index = siblings.findIndex(task => task.id === updated.id);
    const neighbor = siblings[index + (input.move === "up" ? -1 : 1)];
    if (neighbor) {
      const descendants = (root: number): Set<number> => {
        const ids = new Set([root]);
        for (let i = 0; i < tasks.length; i++) for (const task of tasks) if (task.parentId !== undefined && ids.has(task.parentId)) ids.add(task.id);
        return ids;
      };
      const movedIds = descendants(updated.id);
      const neighborIds = descendants(neighbor.id);
      const moved = visible.filter(task => movedIds.has(task.id));
      const adjacent = visible.filter(task => neighborIds.has(task.id));
      const swapped = input.move === "up" ? [...moved, ...adjacent] : [...adjacent, ...moved];
      const first = Math.min(visible.findIndex(task => movedIds.has(task.id)), visible.findIndex(task => neighborIds.has(task.id)));
      const remaining = visible.filter(task => !movedIds.has(task.id) && !neighborIds.has(task.id));
      const reordered = [...remaining.slice(0, first), ...swapped, ...remaining.slice(first)];
      // Keep tombstones available for historical references without allowing them
      // to interrupt a visible subtree when it is moved.
      tasks.splice(0, tasks.length, ...reordered, ...tasks.filter(task => task.status === "deleted"));
    }
  }
  const changed = JSON.stringify(current) !== JSON.stringify(updated) || tasks.some((task, index) => task.id !== state.tasks[index]?.id);
  return { state: changed ? { ...state, tasks } : state, message: changed ? `Updated #${updated.id}` : `No change to #${updated.id}`, changed };
}
