import { z } from "zod";

export const statusSchema = z.enum(["pending", "in_progress", "completed", "deleted"]);
export const taskSchema = z.object({
  id: z.number().int().positive(), subject: z.string(), description: z.string().optional(),
  activeForm: z.string().optional(), status: statusSchema, parentId: z.number().int().positive().optional(),
  blockedBy: z.array(z.number().int().positive()), owner: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Task = z.infer<typeof taskSchema>;
export type State = { nextId: number; tasks: Task[] };
export const initialState = (): State => ({ nextId: 1, tasks: [] });
export const inputSchema = z.object({
  action: z.enum(["create", "update", "list", "get", "delete"]),
  subject: z.string().optional(), description: z.string().optional(), activeForm: z.string().optional(),
  status: statusSchema.optional(), parentId: z.number().int().positive().nullable().optional(),
  blockedBy: z.array(z.number().int().positive()).optional(),
  addBlockedBy: z.array(z.number().int().positive()).optional(),
  removeBlockedBy: z.array(z.number().int().positive()).optional(),
  owner: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
  id: z.number().int().positive().optional(), includeDeleted: z.boolean().optional(),
}).strict();
export type Input = z.infer<typeof inputSchema>;

const transitions: Record<Task["status"], readonly Task["status"][]> = {
  pending: ["pending", "in_progress", "completed", "deleted"],
  in_progress: ["in_progress", "pending", "completed", "deleted"],
  completed: ["completed", "deleted"], deleted: ["deleted"],
};
function fail(message: string): never { throw new Error(message); }
function validateGraph(tasks: Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    if (task.parentId !== undefined && !byId.has(task.parentId)) fail(`Parent #${task.parentId} not found`);
    if (task.blockedBy.some(id => !byId.has(id))) fail(`Unknown dependency for #${task.id}`);
    if (task.blockedBy.length !== new Set(task.blockedBy).size) fail(`Duplicate dependency for #${task.id}`);
  }
  const visit = (task: Task, edge: (task: Task) => number[], visited: Set<number>, stack: Set<number>) => {
    if (stack.has(task.id)) fail(`Cycle involving #${task.id}`);
    if (visited.has(task.id)) return;
    stack.add(task.id);
    for (const id of edge(task)) visit(byId.get(id)!, edge, visited, stack);
    stack.delete(task.id); visited.add(task.id);
  };
  for (const edge of [(task: Task) => task.parentId === undefined ? [] : [task.parentId], (task: Task) => task.blockedBy]) {
    const visited = new Set<number>();
    for (const task of tasks) visit(task, edge, visited, new Set());
  }
  if (tasks.filter(task => task.status === "in_progress").length > 1) fail("Only one task may be in_progress");
}


export function apply(state: State, input: Input): { state: State; result: Task | Task[] } {
  const next: State = { nextId: state.nextId, tasks: state.tasks.map(task => ({ ...task, blockedBy: [...task.blockedBy], ...(task.metadata ? { metadata: { ...task.metadata } } : {}) })) };
  if (input.action === "list") return { state, result: state.tasks.filter(t =>
    input.status ? t.status === input.status : input.includeDeleted || t.status === "pending" || t.status === "in_progress") };
  const task = next.tasks.find(t => t.id === input.id);
  if (input.action === "get") return { state, result: task ?? fail(`#${input.id} not found`) };
  let changed: Task;
  if (input.action === "create") {
    if (!input.subject?.trim()) fail("subject required for create");
    const status = input.status ?? "pending";
    if (status !== "pending" && status !== "in_progress") fail("Create requires pending or in_progress");
    changed = { id: next.nextId++, subject: input.subject.trim(), status, blockedBy: input.blockedBy ?? [],
      ...(input.parentId != null ? { parentId: input.parentId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) };
    next.tasks.push(changed);
  } else {
    if (!task) fail(`#${input.id} not found`);
    if (input.action === "delete") {
      if (task.status === "deleted") fail(`#${task.id} is already deleted`);
      task.status = "deleted";
    } else {
      if (Object.keys(input).every(key => key === "action" || key === "id")) fail("update requires a mutable field");
      if (input.subject !== undefined) { if (!input.subject.trim()) fail("subject must not be empty"); task.subject = input.subject.trim(); }
      if (input.status !== undefined) {
        if (!transitions[task.status].includes(input.status)) fail(`Illegal transition ${task.status} → ${input.status}`);
        task.status = input.status;
      }
      if (input.parentId === null) delete task.parentId;
      else if (input.parentId !== undefined) task.parentId = input.parentId;
      if (input.description !== undefined) task.description = input.description;
      if (input.activeForm !== undefined) task.activeForm = input.activeForm;
      if (input.owner !== undefined) task.owner = input.owner;
      if (input.blockedBy !== undefined) fail("Use addBlockedBy/removeBlockedBy on update");
      task.blockedBy = [...new Set([...task.blockedBy, ...(input.addBlockedBy ?? [])])].filter(id => !input.removeBlockedBy?.includes(id));
      if (input.metadata !== undefined) {
        task.metadata = { ...task.metadata, ...input.metadata };
        for (const [key, value] of Object.entries(task.metadata)) if (value === null) delete task.metadata[key];
      }
    }
    changed = task;
  }
  validateGraph(next.tasks);
  const prior = state.tasks.find(task => task.id === changed.id);
  const gainedBlocker = changed.blockedBy.some(id => !prior?.blockedBy.includes(id));
  if ((prior?.status !== changed.status || gainedBlocker) && (changed.status === "in_progress" || changed.status === "completed") &&
      changed.blockedBy.some(id => next.tasks.find(task => task.id === id)?.status !== "completed"))
    fail(`Task #${changed.id} has unfinished dependencies`);
  return { state: next, result: changed };
}
