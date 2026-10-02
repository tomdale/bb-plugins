import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, useBbNavigate, useComposer, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { buildCardView, collapsedSummary, rowIcon, rowState, tasksForRunState, type CardRow, type CardTreeNode } from "./card.js";
import type { Task } from "./model.js";
import { ProgressRing } from "./progress-ring.js";
import { useTodoList } from "./use-todos.js";
import { useTodoSidePlacement } from "./use-side-placement.js";
import { TODO_PANEL_ACTION_ID } from "./editor-button.js";
import type { rpcContract } from "./server.js";

const STATUS_TEXT: Record<Task["status"], string> = { in_progress: "In progress", pending: "Pending", completed: "Completed", deleted: "Deleted" };

function TodoRowContent({ row, ordered, working, subjects, ordinals }: { row: CardRow; ordered: boolean; working: boolean; subjects: Map<number, string>; ordinals: Map<number, number> }) {
  const { task, blockers, ordinal } = row;
  const state = rowState(row);
  const spinning = state === "active" && working;
  const waitsFor = blockers.map(id => `${ordinals.get(id) ?? id}. ${subjects.get(id) ?? ""}`.trim()).join(", ");
  const text = (state === "active" && task.activeForm?.trim()) || task.subject;
  return <>
    {ordered ? <span className="todo-row-marker todo-row-marker-ordered" aria-hidden="true">
      <span className={`todo-row-number${spinning ? " todo-row-number-active" : ""}`}>
        {spinning
          ? <span className="todo-row-spinner todo-spokes" aria-hidden="true">
            {Array.from({ length: 8 }, (_, spoke) => <i key={spoke} style={{ "--spoke": spoke } as CSSProperties} />)}
          </span>
          : <><span className="todo-row-number-value">{ordinal}</span><span className="todo-row-period">.</span></>}
      </span>
    </span> : <span className="todo-row-marker todo-row-marker-unordered" aria-hidden="true">
      <Icon name={rowIcon(row)} className={`todo-row-status-icon${spinning ? " animate-spin" : ""}`} />
    </span>}
    <span className="todo-row-text" title={text}>
      <span className="todo-sr">{STATUS_TEXT[task.status]}{blockers.length ? `, waiting for ${waitsFor}` : ""}: </span>
      {text}
    </span>
    {blockers.length > 0 && <span className="todo-row-meta" aria-hidden="true" title={`Depends on ${waitsFor}`}>
      depends on {blockers.map(id => ordinals.get(id) ?? id).join(", ")}
    </span>}
  </>;
}

function TodoRow({ row, ordered, working, subjects, ordinals }: { row: CardRow; ordered: boolean; working: boolean; subjects: Map<number, string>; ordinals: Map<number, number> }) {
  const { depth } = row;
  const state = rowState(row);
  return (
    <li className={`todo-row todo-row-${state}`} data-depth={depth || undefined}
      style={depth ? { "--todo-depth": depth } as CSSProperties : undefined}>
      <TodoRowContent row={row} ordered={ordered} working={working} subjects={subjects} ordinals={ordinals} />
    </li>
  );
}

function TodoTreeItem({ node, ordered, working, subjects, ordinals }: { node: CardTreeNode; ordered: boolean; working: boolean; subjects: Map<number, string>; ordinals: Map<number, number> }) {
  const { row, children } = node;
  const state = rowState(row);
  const depth = row.depth;
  if (!children.length) {
    return (
      <li className={`todo-row todo-row-${state}`} data-depth={depth || undefined}
        style={depth ? { "--todo-depth": depth } as CSSProperties : undefined}>
        <TodoRowContent row={row} ordered={ordered} working={working} subjects={subjects} ordinals={ordinals} />
      </li>
    );
  }
  return (
    <li className="todo-item-group" data-task-id={row.task.id}>
      <div className={`todo-row todo-row-${state}`} data-depth={depth || undefined}
        style={depth ? { "--todo-depth": depth } as CSSProperties : undefined}>
        <TodoRowContent row={row} ordered={ordered} working={working} subjects={subjects} ordinals={ordinals} />
      </div>
      <ul className="todo-subtasks" aria-label={`Subtasks of #${row.task.id}`}>
        {children.map(child => (
          <TodoTreeItem key={child.row.task.id} node={child} ordered={ordered} working={working} subjects={subjects} ordinals={ordinals} />
        ))}
      </ul>
    </li>
  );
}

/**
 * The Todo banner above a thread or queued-message composer. It is collapsed
 * by default (showing intelligent compact tasks or progress), can be toggled
 * or clicked to show the full list, renders wide lists in 2 columns after they
 * reach their max height with subtasks grouped under their parent, adds scroll
 * fade gradients when overflowing, and moves into the thread's right gutter when
 * there is room beside the latest message.
 */
export function TodoCard() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const threadId = composer.scope.kind === "thread" || composer.scope.kind === "queued-message" ? composer.scope.threadId : null;
  const { values: settings } = useSettings();
  const hideDelaySeconds = typeof settings?.completedHideDelaySeconds === "number" ? settings.completedHideDelaySeconds : 30;
  const { state, loaded, error, refresh } = useTodoList(threadId);
  const [hiddenAfterCompletion, setHiddenAfterCompletion] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [useTwoColumns, setUseTwoColumns] = useState(false);
  const [scrollFade, setScrollFade] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`, toggleId = `${baseId}-toggle`;

  useEffect(() => { setExpanded(false); }, [threadId]);
  useEffect(() => { refresh(); }, [composer.isRunning, refresh]);

  const card = useMemo(() => buildCardView(tasksForRunState(state.tasks, composer.isRunning)), [state.tasks, composer.isRunning]);
  const subjects = useMemo(() => new Map(state.tasks.map(task => [task.id, task.subject])), [state.tasks]);
  const ordinals = useMemo(() => new Map(card.rows.map(row => [row.task.id, row.ordinal])), [card.rows]);
  const tasksFingerprint = JSON.stringify(state.tasks);

  useEffect(() => {
    setHiddenAfterCompletion(false);
    if (!threadId || !loaded || !card.allComplete || error) return;
    if (hideDelaySeconds === 0) {
      setHiddenAfterCompletion(true);
      void rpc.call("archiveCompleted", { threadId }).catch(() => {});
      return;
    }
    const timer = window.setTimeout(() => {
      setHiddenAfterCompletion(true);
      void rpc.call("archiveCompleted", { threadId }).catch(() => {});
    }, hideDelaySeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [threadId, loaded, tasksFingerprint, card.allComplete, error, hideDelaySeconds, rpc]);

  const updateListLayout = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      setScrollFade(prev => (prev.top || prev.bottom ? { top: false, bottom: false } : prev));
      return;
    }
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    const maxHeight = Number.parseFloat(getComputedStyle(el).maxHeight);
    const reachedMaxHeight = Number.isFinite(maxHeight) ? el.clientHeight >= maxHeight - 1 : canScroll;
    if (expanded && !useTwoColumns && reachedMaxHeight) setUseTwoColumns(true);
    if (!canScroll) {
      setScrollFade(prev => (prev.top || prev.bottom ? { top: false, bottom: false } : prev));
      return;
    }
    const isTop = el.scrollTop <= 1;
    const isBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setScrollFade(prev => {
      const next = { top: !isTop, bottom: !isBottom };
      return prev.top === next.top && prev.bottom === next.bottom ? prev : next;
    });
  }, [expanded, useTwoColumns]);

  const visible = !!threadId && !(hiddenAfterCompletion && card.allComplete && !error) && (card.total > 0 || !!error);
  const { cardRef, placement } = useTodoSidePlacement(threadId, visible, expanded, composer.scope.kind !== "queued-message");

  const working = composer.isRunning && !card.allComplete;
  const canEdit = composer.scope.kind === "thread";
  const hasInProgress = card.collapsedRows.length > 0;
  const showCountInActions = expanded || hasInProgress;
  const displayRows = expanded ? card.rows : card.collapsedRows;
  const listClassName = `todo-list${expanded && useTwoColumns ? " todo-list-two-columns" : ""}`;
  const listStyle = expanded && useTwoColumns
    ? {
      gridAutoFlow: "column",
      gridTemplateRows: `repeat(${Math.ceil(card.roots.length / 2)}, auto)`,
    } as CSSProperties
    : undefined;

  useLayoutEffect(() => {
    setUseTwoColumns(false);
  }, [displayRows.length, expanded]);

  useLayoutEffect(() => {
    updateListLayout();
  }, [displayRows.length, expanded, updateListLayout]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateListLayout());
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateListLayout]);

  if (!visible) return null;

  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [role="button"]')) return;
    if (typeof window !== "undefined" && window.getSelection()?.toString().trim()) return;
    setExpanded(prev => !prev);
  };

  const frame = (className: string, children: ReactNode) => {
    const content = <div ref={cardRef} className={`todo-card ${className}${placement ? " todo-card-floating" : ""}`}
      data-floating={placement ? "" : undefined}
      data-state={expanded ? "expanded" : "collapsed"}
      data-collapsed={!expanded ? "" : undefined}
      onClick={handleCardClick}
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

  return frame(card.allComplete ? "todo-card-done" : "", (
    <div className="todo-card-inner">
      {error && <p role="alert" className="todo-error">Couldn't refresh todos: {error}</p>}
      <div className="todo-card-content">
        {expanded ? (
          <div className="todo-list-wrapper">
            {scrollFade.top && <div className="todo-scroll-fade todo-scroll-fade-top" data-fade="top" aria-hidden="true" />}
            <ul ref={listRef} id={listId} className={listClassName} style={listStyle} onScroll={updateListLayout} aria-label="All todos">
              {card.roots.map(node => (
                <TodoTreeItem
                  key={node.row.task.id}
                  node={node}
                  ordered={card.isOrdered}
                  working={working}
                  subjects={subjects}
                  ordinals={ordinals}
                />
              ))}
            </ul>
            {scrollFade.bottom && <div className="todo-scroll-fade todo-scroll-fade-bottom" data-fade="bottom" aria-hidden="true" />}
          </div>
        ) : hasInProgress ? (
          <div className="todo-list-wrapper">
            {scrollFade.top && <div className="todo-scroll-fade todo-scroll-fade-top" data-fade="top" aria-hidden="true" />}
            <ul ref={listRef} id={listId} className={listClassName} onScroll={updateListLayout} aria-label="Active todos">
              {card.collapsedRows.map(row => (
                <TodoRow
                  key={row.task.id}
                  row={row}
                  ordered={card.isOrdered}
                  working={working}
                  subjects={subjects}
                  ordinals={ordinals}
                />
              ))}
            </ul>
            {scrollFade.bottom && <div className="todo-scroll-fade todo-scroll-fade-bottom" data-fade="bottom" aria-hidden="true" />}
          </div>
        ) : card.allComplete ? (
          <div className="todo-summary" id={listId} aria-label="All todos complete">
            <Icon name="CircleCheck" className="todo-summary-icon text-muted-foreground" aria-hidden="true" />
            <span className="todo-summary-text">{collapsedSummary(card)}</span>
          </div>
        ) : (
          <div className="todo-summary" id={listId} aria-label={collapsedSummary(card)}>
            <ProgressRing completed={card.completed} total={card.total} className="todo-summary-icon text-muted-foreground" />
            <span className="todo-summary-text">{collapsedSummary(card)}</span>
          </div>
        )}
        <div className="todo-actions">
          <button
            type="button"
            id={toggleId}
            className="todo-view-toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-label={expanded ? "Show compact todos" : `Show all ${card.total} todos`}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(prev => !prev);
            }}
          >
            {showCountInActions && (
              <span className="todo-count" aria-hidden="true">{card.completed}/{card.total}</span>
            )}
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="todo-chevron" aria-hidden="true" />
          </button>
          {canEdit && (
            <button
              type="button"
              className="todo-edit"
              aria-label="Edit todos"
              title="Edit todos"
              onClick={(e) => {
                e.stopPropagation();
                navigate.openThreadPanel({ actionId: TODO_PANEL_ACTION_ID });
              }}
            >
              <Icon name="Edit" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  ));
}
