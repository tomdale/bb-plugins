export type Status = "pending" | "in_progress" | "completed";
export interface Task {
  id: number;
  subject: string;
  status: Status;
  parentId?: number;
}
export interface State { tasks: Task[]; nextId: number }

export const emptyState = (): State => ({ tasks: [], nextId: 1 });

/** A plan numbered 1..n in the given order, with its first task in progress. */
export const newPlan = (subjects: readonly string[]): State => ({
  tasks: subjects.map((subject, index) => ({ id: index + 1, subject, status: index === 0 ? "in_progress" : "pending" })),
  nextId: subjects.length + 1,
});

export const addTask = (state: State, subject: string, parentId?: number): State => ({
  tasks: [...state.tasks, { id: state.nextId, subject, status: "pending", ...(parentId === undefined ? {} : { parentId }) }],
  nextId: state.nextId + 1,
});

export const setStatus = (state: State, id: number, status: Status): State => ({
  ...state,
  tasks: state.tasks.map(task => task.id === id ? { ...task, status } : task),
});

/** Display order: each task is followed by its subtasks. A task whose parent is absent is a root. */
export function ordered(tasks: readonly Task[]): Task[] {
  const ids = new Set(tasks.map(task => task.id));
  const result: Task[] = [];
  const visit = (parentId?: number) => {
    for (const task of tasks) {
      if ((task.parentId !== undefined && ids.has(task.parentId) ? task.parentId : undefined) !== parentId) continue;
      result.push(task);
      visit(task.id);
    }
  };
  visit();
  return result;
}
