import type { Input, Status, Task } from "./model.js";

/** One task in the editor tree, with the structural moves the reducer accepts from here. */
export interface EditorNode {
  task: Task;
  depth: number;
  children: EditorNode[];
  /** Unfinished visible tasks this task waits on. */
  waitingOn: number[];
  /** Visible tasks that name this task in `blockedBy`. */
  blocks: number[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The previous sibling, which becomes the parent when the task is indented. */
  indentParentId: number | undefined;
  /** The parent to move to when outdented: `null` for the root, `undefined` when already at the root. */
  outdentParentId: number | null | undefined;
}

export interface EditorView {
  roots: EditorNode[];
  /** Visible tasks in display order; the reducer's sibling order for each parent. */
  ordered: Task[];
  total: number;
  completed: number;
  current: Task | undefined;
}

/**
 * Builds the editor tree with the same visibility rules as the composer card:
 * tombstones are hidden and a task whose parent is hidden or missing is shown
 * at the root. Parent cycles have no root, so their members are appended flat.
 */
export function buildEditorView(tasks: readonly Task[]): EditorView {
  const visible = tasks.filter(task => task.status !== "deleted");
  const byId = new Map(visible.map(task => [task.id, task]));
  const parentOf = (task: Task) => task.parentId !== undefined && task.parentId !== task.id && byId.has(task.parentId) ? task.parentId : undefined;
  const groups = new Map<number | undefined, Task[]>();
  for (const task of visible) groups.set(parentOf(task), [...(groups.get(parentOf(task)) ?? []), task]);
  const blocks = new Map<number, number[]>();
  for (const task of visible) for (const id of task.blockedBy ?? []) if (byId.has(id)) blocks.set(id, [...(blocks.get(id) ?? []), task.id]);
  // A parent-cycle member's grandparent can be the task itself; outdent to the root instead.
  const outdentTarget = (task: Task, parent: Task) => {
    const grandparent = parentOf(parent);
    return grandparent === undefined || grandparent === task.id ? null : grandparent;
  };
  const visited = new Set<number>();
  const ordered: Task[] = [];
  const build = (siblings: readonly Task[], depth: number, parent: Task | undefined): EditorNode[] => {
    const pending = siblings.filter(task => !visited.has(task.id));
    return pending.map((task, index) => {
      visited.add(task.id);
      ordered.push(task);
      const waitingOn = task.status === "completed" ? [] : (task.blockedBy ?? []).filter(id => {
        const blocker = byId.get(id);
        return blocker !== undefined && blocker.id !== task.id && blocker.status !== "completed";
      });
      const node: EditorNode = {
        task, depth, children: [], waitingOn, blocks: blocks.get(task.id) ?? [],
        canMoveUp: index > 0, canMoveDown: index < pending.length - 1,
        indentParentId: index > 0 ? pending[index - 1]!.id : undefined,
        outdentParentId: parent === undefined ? undefined : outdentTarget(task, parent),
      };
      node.children = build(groups.get(task.id) ?? [], depth + 1, task);
      return node;
    });
  };
  const roots = build(groups.get(undefined) ?? [], 0, undefined);
  for (const task of visible) if (!visited.has(task.id)) roots.push(...build([task], 0, undefined));
  const completed = visible.filter(task => task.status === "completed").length;
  return { roots, ordered, total: visible.length, completed, current: visible.find(task => task.status === "in_progress") };
}

export interface StatusOption {
  status: Exclude<Status, "deleted">;
  label: string;
  disabled: boolean;
  /** Why the option is unavailable, for the menu's secondary text. */
  reason?: string;
}

/** Status choices for one task, mirroring the reducer's transitions. */
export function statusOptions(task: Task): StatusOption[] {
  const done = task.status === "completed";
  return [
    { status: "pending", label: "Pending", disabled: done, reason: done ? "Completed todos can't reopen" : undefined },
    {
      status: "in_progress", label: "In progress", disabled: done,
      reason: done ? "Completed todos can't reopen" : undefined,
    },
    { status: "completed", label: "Completed", disabled: false },
  ];
}

/** Candidate blockers for a task: visible tasks not already listed and not the task itself. */
export function blockerCandidates(task: Task, ordered: readonly Task[]): Task[] {
  return ordered.filter(other => other.id !== task.id && !task.blockedBy?.includes(other.id));
}

/** The reducer change for a structural editor command, or null when the command does not apply. */
export function structuralChange(node: EditorNode, command: "up" | "down" | "indent" | "outdent"): Input | null {
  const id = node.task.id;
  if (command === "up") return node.canMoveUp ? { action: "update", id, move: "up" } : null;
  if (command === "down") return node.canMoveDown ? { action: "update", id, move: "down" } : null;
  if (command === "indent") return node.indentParentId === undefined ? null : { action: "update", id, parentId: node.indentParentId };
  return node.outdentParentId === undefined ? null : { action: "update", id, parentId: node.outdentParentId };
}
