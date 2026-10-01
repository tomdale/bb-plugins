import type { Task } from "./model.js";

/** One rendered list row; depth and blockers come from native task relationships. */
export interface CardRow {
  task: Task;
  depth: number;
  /** Ids of visible, unfinished tasks named in this pending task's `blockedBy`. */
  blockers: number[];
}

export interface CardView {
  rows: CardRow[];
  collapsedRows: CardRow[];
  total: number;
  completed: number;
  current: Task | undefined;
  allComplete: boolean;
  /** Task ids are shown only when a blocker label needs something to refer to. */
  showIds: boolean;
}

/** An idle thread can retain the last in-progress status until the next update. */
export function tasksForRunState(tasks: readonly Task[], isRunning: boolean): readonly Task[] {
  if (isRunning) return tasks;
  return tasks.map(task => task.status === "in_progress" ? { ...task, status: "pending" } : task);
}

export function selectCollapsedRows(rows: readonly CardRow[]): CardRow[] {
  return rows.filter(row => row.task.status === "in_progress").map(row => ({ ...row, depth: 0 }));
}

export function collapsedSummary(view: CardView): string {
  if (view.allComplete) return "All todos complete";
  return `${view.completed} of ${view.total} todos done`;
}

export function buildCardView(tasks: readonly Task[]): CardView {
  const visible = tasks.filter(task => task.status !== "deleted");
  const byId = new Map(visible.map(task => [task.id, task]));
  const groups = new Map<number | undefined, Task[]>();
  for (const task of visible) {
    // A parent that was deleted or never existed promotes the child to the root.
    const parent = task.parentId !== undefined && task.parentId !== task.id && byId.has(task.parentId) ? task.parentId : undefined;
    groups.set(parent, [...(groups.get(parent) ?? []), task]);
  }
  const rows: CardRow[] = [];
  const visited = new Set<number>();
  const append = (parent: number | undefined, depth: number) => {
    const siblings = groups.get(parent) ?? [];
    for (const task of siblings) {
      if (visited.has(task.id)) continue;
      visited.add(task.id);
      const blockers = task.status !== "pending" ? [] : (task.blockedBy ?? []).filter(id => {
        const blocker = byId.get(id);
        return blocker !== undefined && blocker.id !== task.id && blocker.status !== "completed";
      });
      rows.push({ task, depth, blockers });
      append(task.id, depth + 1);
    }
  };
  append(undefined, 0);
  // Parent cycles have no root; surface them flat rather than dropping tasks.
  for (const task of visible) if (!visited.has(task.id)) { rows.push({ task, depth: 0, blockers: [] }); visited.add(task.id); append(task.id, 1); }
  const completed = visible.filter(task => task.status === "completed").length;
  return {
    rows,
    collapsedRows: selectCollapsedRows(rows),
    total: visible.length,
    completed,
    current: visible.find(task => task.status === "in_progress"),
    allComplete: visible.length > 0 && completed === visible.length,
    showIds: rows.some(row => row.blockers.length > 0),
  };
}

/** The card opens by itself only while an agent is actively working a task. */
export function autoExpanded(view: CardView, isRunning: boolean): boolean {
  return isRunning && view.current !== undefined && !view.allComplete;
}

export function currentLabel(view: CardView): string | null {
  if (!view.current || view.allComplete) return null;
  return view.current.activeForm?.trim() || view.current.subject;
}

export type TodoRowState = "active" | "completed" | "blocked" | "pending";

export function rowState(row: CardRow): TodoRowState {
  if (row.task.status === "in_progress") return "active";
  if (row.task.status === "completed") return "completed";
  return row.blockers.length > 0 ? "blocked" : "pending";
}

export type TodoRowIcon = "CircleCheck" | "Circle" | "Lock" | "Spinner";

const ROW_ICONS: Record<TodoRowState, TodoRowIcon> = { active: "Spinner", completed: "CircleCheck", blocked: "Lock", pending: "Circle" };

export function rowIcon(row: CardRow): TodoRowIcon {
  return ROW_ICONS[rowState(row)];
}
