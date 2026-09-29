import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useComposerView, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { Task } from "./model.js";
import "./app.css";

function TodoCard() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" || view.scope.kind === "queued-message" ? view.scope.threadId
    : view.scope.kind === "side-chat" ? view.scope.childThreadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    if (!threadId) { setTasks([]); setError(null); return; }
    rpc.call("snapshot", { threadId }).then(result => {
      if (generation.current === request) { setTasks(result.tasks); setError(null); }
    }, cause => {
      if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId]);
  useEffect(() => { setTasks([]); setExpanded(true); refresh(); return () => { generation.current++; }; }, [threadId, refresh]);
  useEffect(() => { refresh(); }, [connection, refresh]);
  useRealtime("todo-timeline-changed", payload => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  // Lifecycle events can arrive before the final tool completion is persisted.
  // Reconcile while running, and once more on the run-to-idle transition.
  useEffect(() => {
    if (!view.run.isRunning || !threadId) { refresh(); return; }
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [view.run.isRunning, threadId, refresh]);
  const visible = useMemo(() => tasks.filter(task => task.status !== "deleted"), [tasks]);
  const byId = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const children = useMemo(() => {
    const groups = new Map<number | undefined, Task[]>();
    for (const task of visible) {
      const parent = visible.some(candidate => candidate.id === task.parentId) ? task.parentId : undefined;
      groups.set(parent, [...(groups.get(parent) ?? []), task]);
    }
    const rows: { task: Task; depth: number }[] = [];
    const visited = new Set<number>();
    const append = (parent: number | undefined, depth: number) => {
      const siblings = [...(groups.get(parent) ?? [])].sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress"));
      for (const task of siblings) {
        if (visited.has(task.id)) continue;
        visited.add(task.id); rows.push({ task, depth }); append(task.id, depth + 1);
      }
    };
    append(undefined, 0);
    for (const task of visible) if (!visited.has(task.id)) { rows.push({ task, depth: 0 }); append(task.id, 1); }
    return rows;
  }, [visible]);
  if (!threadId || (!visible.length && !error)) return null;
  const done = visible.filter(task => task.status === "completed").length;
  const current = visible.find(task => task.status === "in_progress");
  return <div className="todo-card">
    <button type="button" className="todo-header" aria-expanded={expanded} aria-controls="todo-card-rows" onClick={() => setExpanded(open => !open)}>
      <span aria-hidden="true">☷</span><span className="todo-title">{done}/{visible.length} complete{current ? ` · ${current.activeForm || current.subject}` : ""}</span><span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button>
    {expanded && <div id="todo-card-rows" className="todo-body">
      {error && <p role="alert" className="todo-error">Todo timeline unavailable: {error}</p>}
      <ul>{children.map(({ task, depth }) => {
        const blockers = task.blockedBy?.filter(id => byId.get(id)?.status !== "completed") ?? [];
        return <li key={task.id} style={{ paddingInlineStart: `${depth * 14}px` }}>
          <span className="todo-glyph" aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "in_progress" ? "◌" : "□"}</span>
          <span className="todo-text"><span>#{task.id} {task.subject}</span>
            {task.status === "in_progress" && task.activeForm && <small>{task.activeForm}</small>}
            {blockers.length > 0 && <small>Blocked by {blockers.map(id => `#${id}`).join(", ")}</small>}
          </span>
        </li>;
      })}</ul>
    </div>}
  </div>;
}
export default definePluginApp(app => {
  app.composer.customize({ id: "pi-todo-renderer", scopes: ["thread", "queued-message", "side-chat"], banners: [{ id: "todos", chrome: "card", component: TodoCard }] });
});
