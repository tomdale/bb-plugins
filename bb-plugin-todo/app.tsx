import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { definePluginApp, experimental_Icon as Icon, useComposerView, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { Task } from "./model.js";
import { autoExpanded, buildCardView, currentLabel, headerIcon, rowIcon, type CardRow } from "./card.js";
import "./app.css";

// Shimmer only the active task text while the agent is running. The spinner
// communicates status separately, and the summary remains visually stable.
const shine = (on: boolean) => on ? " animate-shine" : "";
const STATUS_TEXT: Record<Task["status"], string> = { in_progress: "In progress", pending: "Pending", completed: "Completed", deleted: "Deleted" };

function TodoRow({ row, showIds, working }: { row: CardRow; showIds: boolean; working: boolean }) {
  const { task, depth, blockers } = row;
  const state = task.status === "in_progress" ? "active" : task.status === "completed" ? "completed" : blockers.length ? "blocked" : "pending";
  const active = state === "active";
  return <li className={`todo-row todo-row-${state}`} data-depth={depth || undefined} style={depth ? { "--todo-depth": depth } as CSSProperties : undefined}>
    <Icon name={rowIcon(row)} className={`todo-row-icon${active ? " todo-row-spinner animate-spin" : ""}`} aria-hidden="true" />
    <span className={`todo-row-text${shine(active && working)}`} title={task.subject}>
      <span className="todo-sr">{STATUS_TEXT[task.status]}{blockers.length ? ", blocked" : ""}: </span>
      {showIds && <span className="todo-row-id">#{task.id}</span>}
      {task.subject}
    </span>
    {blockers.length > 0 && <span className="todo-row-meta">after {blockers.map(id => `#${id}`).join(", ")}</span>}
  </li>;
}

function TodoCard() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" || view.scope.kind === "queued-message" ? view.scope.threadId
    : view.scope.kind === "side-chat" ? view.scope.childThreadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A manual toggle holds only until the automatic state it overrode changes,
  // so the next run (or its completion) takes over again.
  const [override, setOverride] = useState<{ auto: boolean; open: boolean } | null>(null);
  const generation = useRef(0);
  // Thread and queued-message composers can mount this card at the same time.
  const baseId = useId();
  const bodyId = `${baseId}-body`, toggleId = `${baseId}-toggle`;
  const refresh = useCallback(() => {
    const request = ++generation.current;
    if (!threadId) { setTasks([]); setError(null); return; }
    rpc.call("snapshot", { threadId }).then(result => {
      if (generation.current === request) { setTasks(result.tasks); setError(null); }
    }, cause => {
      if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId]);
  useEffect(() => { setTasks([]); setOverride(null); refresh(); return () => { generation.current++; }; }, [threadId, refresh]);
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
  const card = useMemo(() => buildCardView(tasks), [tasks]);
  if (!threadId) return null;
  if (!card.total) {
    if (!error) return null;
    return <div className="todo-card">
      <div className="todo-header todo-header-error" role="alert" title={error}>
        <Icon name="ListTodo" className="todo-header-icon" aria-hidden="true" />
        <span className="todo-summary">Todo timeline unavailable</span>
      </div>
    </div>;
  }
  const auto = autoExpanded(card, view.run.isRunning);
  const expanded = override && override.auto === auto ? override.open : auto;
  const working = view.run.isRunning && !card.allComplete;
  const current = currentLabel(card);
  const summary = `${card.completed}/${card.total} complete`;
  return <div className={`todo-card${card.allComplete ? " todo-card-done" : ""}`}>
    <button type="button" id={toggleId} className="todo-header" aria-expanded={expanded} aria-controls={bodyId}
      aria-label={`To-do list: ${card.completed} of ${card.total} ${card.total === 1 ? "item" : "items"} complete${current ? `; ${current}` : ""}`}
      onClick={() => setOverride({ auto, open: !expanded })}>
      <Icon name={headerIcon(card)} className={`todo-header-icon${card.current && !card.allComplete ? " todo-header-spinner animate-spin" : ""}`} aria-hidden="true" />
      <span className="todo-summary">{summary}</span>
      <span className="todo-current" title={current ?? undefined}>{current}</span>
      <Icon name="ChevronDown" className="todo-chevron" aria-hidden="true" />
    </button>
    <section id={bodyId} role="region" aria-labelledby={toggleId} aria-hidden={!expanded} inert={!expanded}
      className="todo-body" data-expanded={expanded || undefined}>
      <div className="todo-body-inner">
        {error && <p role="alert" className="todo-error">Todo timeline unavailable: {error}</p>}
        <ul className="todo-list">{card.rows.map(row => <TodoRow key={row.task.id} row={row} showIds={card.showIds} working={working} />)}</ul>
      </div>
    </section>
  </div>;
}
export default definePluginApp(app => {
  app.composer.customize({ id: "pi-todo-renderer", scopes: ["thread", "queued-message", "side-chat"], banners: [{ id: "todos", chrome: "card", component: TodoCard }] });
});
