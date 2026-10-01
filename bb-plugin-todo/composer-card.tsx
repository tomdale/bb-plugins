import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, useBbNavigate, useComposer, useSettings } from "@get-bb/plugin-sdk/app";
import { autoExpanded, buildCardView, cardTitle, rowIcon, rowState, tasksForRunState, type CardRow } from "./card.js";
import type { Task } from "./model.js";
import { ProgressRing } from "./progress-ring.js";
import { useTodoList } from "./use-todos.js";
import { useTodoSidePlacement } from "./use-side-placement.js";
import { TODO_PANEL_ACTION_ID } from "./editor-button.js";

const STATUS_TEXT: Record<Task["status"], string> = { in_progress: "In progress", pending: "Pending", completed: "Completed", deleted: "Deleted" };

function TodoRow({ row, showIds, working, subjects }: { row: CardRow; showIds: boolean; working: boolean; subjects: Map<number, string> }) {
  const { task, depth, blockers } = row;
  const state = rowState(row);
  const spinning = state === "active" && working;
  const waitsFor = blockers.map(id => `#${id} ${subjects.get(id) ?? ""}`.trim()).join(", ");
  return <li className={`todo-row todo-row-${state}`} data-depth={depth || undefined}
    style={depth ? { "--todo-depth": depth } as CSSProperties : undefined}>
    <Icon name={rowIcon(row)} className={`todo-row-icon${spinning ? " todo-row-spinner animate-spin" : ""}`} aria-hidden="true" />
    <span className="todo-row-text" title={task.subject}>
      <span className="todo-sr">{STATUS_TEXT[task.status]}{blockers.length ? `, waiting for ${waitsFor}` : ""}: </span>
      {showIds && <span className="todo-row-id" aria-hidden="true">{task.id}</span>}
      {task.subject}
    </span>
    {blockers.length > 0 && <span className="todo-row-meta" aria-hidden="true" title={`Waits for ${waitsFor}`}>
      after {blockers.map(id => `#${id}`).join(", ")}
    </span>}
  </li>;
}

/**
 * The Todo banner above a thread or queued-message composer. It is collapsed
 * unless the agent is working a task, hides itself a configurable time after
 * every task completes, and moves into the thread's right gutter when there is
 * room beside the latest message.
 */
export function TodoCard() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const threadId = composer.scope.kind === "thread" || composer.scope.kind === "queued-message" ? composer.scope.threadId : null;
  const { values: settings } = useSettings();
  const hideDelaySeconds = typeof settings?.completedHideDelaySeconds === "number" ? settings.completedHideDelaySeconds : 30;
  const { state, loaded, error, refresh } = useTodoList(threadId);
  const [hiddenAfterCompletion, setHiddenAfterCompletion] = useState(false);
  // A manual toggle holds only until the automatic state it overrode changes,
  // so the next run (or its completion) takes over again.
  const [override, setOverride] = useState<{ auto: boolean; open: boolean } | null>(null);
  // Thread and queued-message composers can mount this card at the same time.
  const baseId = useId();
  const bodyId = `${baseId}-body`, toggleId = `${baseId}-toggle`;
  useEffect(() => { setOverride(null); }, [threadId]);
  // The server settles in-progress tasks when a run ends; refetch on both edges.
  useEffect(() => { refresh(); }, [composer.isRunning, refresh]);
  const card = useMemo(() => buildCardView(tasksForRunState(state.tasks, composer.isRunning)), [state.tasks, composer.isRunning]);
  const subjects = useMemo(() => new Map(state.tasks.map(task => [task.id, task.subject])), [state.tasks]);
  const tasksFingerprint = JSON.stringify(state.tasks);
  useEffect(() => {
    setHiddenAfterCompletion(false);
    if (!threadId || !loaded || !card.allComplete || error) return;
    if (hideDelaySeconds === 0) { setHiddenAfterCompletion(true); return; }
    const timer = window.setTimeout(() => setHiddenAfterCompletion(true), hideDelaySeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [threadId, loaded, tasksFingerprint, card.allComplete, error, hideDelaySeconds]);
  const auto = autoExpanded(card, composer.isRunning);
  const expanded = override && override.auto === auto ? override.open : auto;
  const visible = !!threadId && !(hiddenAfterCompletion && card.allComplete && !error) && (card.total > 0 || !!error);
  const { cardRef, placement } = useTodoSidePlacement(threadId, visible, expanded, composer.scope.kind !== "queued-message");
  if (!visible) return null;
  const frame = (className: string, children: ReactNode) => {
    const content = <div ref={cardRef} className={`todo-card ${className}${placement ? " todo-card-floating" : ""}`}
      data-floating={placement ? "" : undefined}
      style={placement ? { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight } : undefined}>
      {children}
    </div>;
    return placement && typeof document !== "undefined" ? createPortal(content, document.body) : content;
  };
  if (!card.total) {
    return frame("todo-card-error", <div className="todo-header" role="alert" title={error ?? undefined}>
      <span className="todo-toggle">
        <Icon name="AlertCircle" className="todo-header-icon" aria-hidden="true" />
        <span className="todo-title">Todos unavailable</span>
      </span>
    </div>);
  }
  const working = composer.isRunning && !card.allComplete;
  const title = cardTitle(card);
  const shining = working && card.current !== undefined;
  // The queued-message editor has no thread side panel to open.
  const canEdit = composer.scope.kind === "thread";
  return frame(card.allComplete ? "todo-card-done" : "", <>
    <div className="todo-header">
      <button type="button" id={toggleId} className="todo-toggle" aria-expanded={expanded} aria-controls={bodyId}
        aria-label={`Todos: ${card.completed} of ${card.total} complete${card.current && working ? `; ${title}` : ""}`}
        onClick={() => setOverride({ auto, open: !expanded })}>
        {card.allComplete
          ? <Icon name="CircleCheck" className="todo-header-icon" aria-hidden="true" />
          : <ProgressRing completed={card.completed} total={card.total} className="todo-header-icon" />}
        <span className={`todo-title${shining ? " animate-shine" : ""}`} title={title}>{title}</span>
        <span className="todo-count" aria-hidden="true">{card.completed}/{card.total}</span>
        <Icon name="ChevronDown" className="todo-chevron" aria-hidden="true" />
      </button>
      {canEdit && <button type="button" className="todo-edit" aria-label="Edit todos" title="Edit todos"
        onClick={() => { navigate.openThreadPanel({ actionId: TODO_PANEL_ACTION_ID }); }}>
        <Icon name="Edit" aria-hidden="true" />
      </button>}
    </div>
    <section id={bodyId} role="region" aria-labelledby={toggleId}
      className="todo-body" data-expanded={expanded || undefined} data-preview={!expanded || undefined}>
      <div className="todo-body-inner">
        {error && <p role="alert" className="todo-error">Couldn't refresh todos: {error}</p>}
        <ul className="todo-list">{(expanded ? card.rows : card.collapsedRows).map(row => <TodoRow key={row.task.id} row={row} showIds={card.showIds} working={working} subjects={subjects} />)}</ul>
      </div>
    </section>
  </>);
}
