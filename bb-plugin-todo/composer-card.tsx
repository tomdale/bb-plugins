import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, useBbNavigate, useComposer, useSettings } from "@get-bb/plugin-sdk/app";
import { buildCardView, rowIcon, rowState, tasksForRunState, type CardRow } from "./card.js";
import type { Task } from "./model.js";
import { useTodoList } from "./use-todos.js";
import { useTodoSidePlacement } from "./use-side-placement.js";
import { TODO_PANEL_ACTION_ID } from "./editor-button.js";

const STATUS_TEXT: Record<Task["status"], string> = { in_progress: "In progress", pending: "Pending", completed: "Completed", deleted: "Deleted" };

function TodoRow({ row, showIds, working, subjects }: { row: CardRow; showIds: boolean; working: boolean; subjects: Map<number, string> }) {
  const { task, depth, blockers } = row;
  const state = rowState(row);
  const spinning = state === "active" && working;
  const waitsFor = blockers.map(id => `#${id} ${subjects.get(id) ?? ""}`.trim()).join(", ");
  const text = (state === "active" && task.activeForm?.trim()) || task.subject;
  return <li className={`todo-row todo-row-${state}`} data-depth={depth || undefined}
    style={depth ? { "--todo-depth": depth } as CSSProperties : undefined}>
    <Icon name={rowIcon(row)} className={`todo-row-icon${spinning ? " todo-row-spinner animate-spin" : ""}`} aria-hidden="true" />
    <span className="todo-row-text" title={text}>
      <span className="todo-sr">{STATUS_TEXT[task.status]}{blockers.length ? `, waiting for ${waitsFor}` : ""}: </span>
      {showIds && <span className="todo-row-id" aria-hidden="true">{task.id}</span>}
      {text}
    </span>
    {blockers.length > 0 && <span className="todo-row-meta" aria-hidden="true" title={`Waits for ${waitsFor}`}>
      after {blockers.map(id => `#${id}`).join(", ")}
    </span>}
  </li>;
}

/**
 * The Todo banner above a thread or queued-message composer. It is collapsed
 * by default (showing intelligent compact tasks), can be toggled to show the
 * full list, hides itself a configurable time after every task completes, and
 * moves into the thread's right gutter when there is room beside the latest message.
 */
export function TodoCard() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const threadId = composer.scope.kind === "thread" || composer.scope.kind === "queued-message" ? composer.scope.threadId : null;
  const { values: settings } = useSettings();
  const hideDelaySeconds = typeof settings?.completedHideDelaySeconds === "number" ? settings.completedHideDelaySeconds : 30;
  const { state, loaded, error, refresh } = useTodoList(threadId);
  const [hiddenAfterCompletion, setHiddenAfterCompletion] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const baseId = useId();
  const listId = `${baseId}-list`, toggleId = `${baseId}-toggle`;

  useEffect(() => { setExpanded(false); }, [threadId]);
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
  const canEdit = composer.scope.kind === "thread";
  const displayRows = expanded ? card.rows : card.collapsedRows;

  return frame(card.allComplete ? "todo-card-done" : "", (
    <div className="todo-card-inner">
      {error && <p role="alert" className="todo-error">Couldn't refresh todos: {error}</p>}
      <div className="todo-card-content">
        <ul id={listId} className="todo-list" aria-label={expanded ? "All todos" : "Current todos"}>
          {displayRows.map(row => (
            <TodoRow
              key={row.task.id}
              row={row}
              showIds={card.showIds}
              working={working}
              subjects={subjects}
            />
          ))}
        </ul>
        <div className="todo-actions">
          <button
            type="button"
            id={toggleId}
            className="todo-view-toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-label={expanded ? "Show compact todos" : `Show all ${card.total} todos`}
            onClick={() => setExpanded(prev => !prev)}
          >
            <span className="todo-count" aria-hidden="true">{card.completed}/{card.total}</span>
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="todo-chevron" aria-hidden="true" />
          </button>
          {canEdit && (
            <button
              type="button"
              className="todo-edit"
              aria-label="Edit todos"
              title="Edit todos"
              onClick={() => { navigate.openThreadPanel({ actionId: TODO_PANEL_ACTION_ID }); }}
            >
              <Icon name="Edit" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  ));
}
