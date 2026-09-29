import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { Input, Task } from "./model.js";

export function taskTree(tasks: Task[]): { task: Task; depth: number }[] {
  const visible = tasks.filter(t => t.status !== "deleted");
  const children = new Map<number | undefined, Task[]>();
  for (const task of visible) {
    const parent = visible.some(t => t.id === task.parentId) ? task.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  const rows: { task: Task; depth: number }[] = [];
  const append = (parent: number | undefined, depth: number) => {
    for (const task of children.get(parent) ?? []) {
      rows.push({ task, depth }); append(task.id, depth + 1);
    }
  };
  append(undefined, 0);
  return rows;
}

function TodoPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [subject, setSubject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc.call("todos_list", { threadId, includeDeleted: true }).then(data => { setTasks(data.tasks); setError(null); }, cause => setError(String(cause)));
  }, [rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime("todos-changed", payload => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  const mutate = async (input: Input) => {
    try { const next = await rpc.call("todos_mutate", { threadId, input }); setTasks(next.tasks); setError(null); }
    catch (cause) { setError(String(cause)); }
  };
  const byId = new Map(tasks.map(task => [task.id, task]));
  return <section className="p-4 text-sm text-foreground" aria-label="Thread todos">
    <h2 className="mb-3 text-base font-semibold">Todos</h2>
    <form onSubmit={event => { event.preventDefault(); if (subject.trim()) { void mutate({ action: "create", subject }); setSubject(""); } }} className="mb-3 flex gap-2">
      <input aria-label="Task subject" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1" value={subject} onChange={event => setSubject(event.target.value)} />
      <button type="submit" className="rounded border border-border px-2">Add</button>
    </form>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <ul className="space-y-2">{taskTree(tasks).map(({ task, depth }) => {
      const blockers = task.blockedBy.map(id => byId.get(id)).filter((t): t is Task => !!t && t.status !== "completed");
      return <li key={task.id} style={{ marginInlineStart: `${depth * 16}px` }} className="rounded border border-border p-2">
        <div className="flex items-start gap-2"><span className="font-mono text-muted-foreground">#{task.id}</span><span className="flex-1">{task.subject}</span><span>{task.status}</span></div>
        {task.description && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{task.description}</p>}
        {blockers.length > 0 && <p className="mt-1 text-muted-foreground">Blocked by {blockers.map(t => `#${t.id} ${t.subject}`).join(", ")}</p>}
        <div className="mt-2 flex gap-2">{task.status === "pending" && <button disabled={blockers.length > 0} onClick={() => void mutate({ action: "update", id: task.id, status: "in_progress" })}>Start</button>}
          {(task.status === "pending" || task.status === "in_progress") && <button disabled={blockers.length > 0} onClick={() => void mutate({ action: "update", id: task.id, status: "completed" })}>Complete</button>}
          {task.status === "in_progress" && <button onClick={() => void mutate({ action: "update", id: task.id, status: "pending" })}>Requeue</button>}
          <button onClick={() => void mutate({ action: "delete", id: task.id })}>Delete</button>
        </div>
      </li>;
    })}</ul>
    {tasks.some(t => t.status === "deleted") && <p className="mt-3 text-muted-foreground">{tasks.filter(t => t.status === "deleted").length} deleted (tombstoned)</p>}
  </section>;
}

export default definePluginApp(app => {
  app.slots.threadPanelAction({ id: "todos", title: "Todos", component: TodoPanel });
});
