import { ordered, type Task } from "./model.ts";

/** One rendered list row; depth comes from the task's parent chain. */
export interface CardRow {
  task: Task;
  depth: number;
}

export interface CardTreeNode {
  row: CardRow;
  children: CardTreeNode[];
}

export interface CardView {
  rows: CardRow[];
  roots: CardTreeNode[];
  /** The in-progress rows, flat, shown when the card is collapsed. */
  collapsedRows: CardRow[];
  total: number;
  completed: number;
  allComplete: boolean;
}

/** An idle thread can retain the last in-progress status until the next update. */
export function tasksForRunState(tasks: readonly Task[], isRunning: boolean): readonly Task[] {
  if (isRunning) return tasks;
  return tasks.map(task => task.status === "in_progress" ? { ...task, status: "pending" } : task);
}

/** "1 todo", "3 todos". */
export const todoCount = (count: number) => `${count} ${count === 1 ? "todo" : "todos"}`;

export function collapsedSummary(view: CardView): string {
  if (view.allComplete) return `${todoCount(view.total)} complete`;
  return `${view.completed} of ${todoCount(view.total)} done`;
}

export function buildCardView(tasks: readonly Task[]): CardView {
  const rows: CardRow[] = [];
  const roots: CardTreeNode[] = [];
  const nodes = new Map<number, CardTreeNode>();
  for (const task of ordered(tasks)) {
    // `ordered` lists a parent before its children, so the parent's node exists.
    const parent = task.parentId === undefined ? undefined : nodes.get(task.parentId);
    const row = { task, depth: parent ? parent.row.depth + 1 : 0 };
    const node = { row, children: [] };
    nodes.set(task.id, node);
    (parent?.children ?? roots).push(node);
    rows.push(row);
  }
  const completed = tasks.filter(task => task.status === "completed").length;
  return {
    rows,
    roots,
    collapsedRows: rows.filter(row => row.task.status === "in_progress").map(row => ({ ...row, depth: 0 })),
    total: tasks.length,
    completed,
    allComplete: tasks.length > 0 && completed === tasks.length,
  };
}

export type TodoRowState = "active" | "completed" | "pending";

export function rowState(row: CardRow): TodoRowState {
  if (row.task.status === "in_progress") return "active";
  return row.task.status === "completed" ? "completed" : "pending";
}

export type TodoRowIcon = "CircleCheck" | "Circle" | "Spinner";

const ROW_ICONS: Record<TodoRowState, TodoRowIcon> = { active: "Spinner", completed: "CircleCheck", pending: "Circle" };

export function rowIcon(row: CardRow): TodoRowIcon {
  return ROW_ICONS[rowState(row)];
}
