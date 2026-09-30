import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, experimental_Icon as Icon, useComposerView, useRealtime, useRealtimeConnectionState, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { Task } from "./model.js";
import { autoExpanded, buildCardView, currentLabel, headerIcon, rowIcon, type CardRow } from "./card.js";
import { computeTodoSidePlacement, type TodoRect, type TodoSidePlacement } from "./layout.js";
import "./app.css";

// Shimmer only the active task text while the agent is running. The spinner
// communicates status separately, and the summary remains visually stable.
const shine = (on: boolean) => on ? " animate-shine" : "";
const STATUS_TEXT: Record<Task["status"], string> = { in_progress: "In progress", pending: "Pending", completed: "Completed", deleted: "Deleted" };

function rectOf(element: Element): TodoRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function findComposerScrollArea(composerFooter: HTMLElement): HTMLElement | null {
  if (!composerFooter.closest<HTMLElement>("[data-thread-window]")) return null;
  let node: HTMLElement | null = composerFooter.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.clientHeight > 0) return node;
    node = node.parentElement;
  }
  return null;
}

function useTodoSidePlacement(
  threadId: string | null,
  visible: boolean,
  expanded: boolean,
  canUseSidePlacement: boolean,
) {
  const cardRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const scrollAreaRef = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<TodoSidePlacement | null>(null);
  const measure = useCallback(() => {
    const card = cardRef.current;
    if (!card) { setPlacement(null); return; }
    const footer = footerRef.current ?? card.closest<HTMLElement>("[data-scroll-footer]");
    if (!footer) { setPlacement(null); return; }
    footerRef.current = footer;
    const scrollArea = scrollAreaRef.current ?? findComposerScrollArea(footer);
    if (!scrollArea) { setPlacement(null); return; }
    scrollAreaRef.current = scrollArea;
    const scope = footer.closest<HTMLElement>("[data-thread-window]") ?? footer.closest<HTMLElement>("[data-split-pane-id]");
    if (!scope) { setPlacement(null); return; }
    const scrollRect = scrollArea.getBoundingClientRect();
    const columns = Array.from(scope.querySelectorAll<HTMLElement>("[data-message-column]")).reverse();
    const anchor = columns.find(column => {
      const rect = column.getBoundingClientRect();
      return column.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
    });
    if (!anchor) { setPlacement(null); return; }
    anchorRef.current = anchor;
    const scrollAreaRect = rectOf(scrollArea);
    const footerRect = rectOf(footer);
    const usableBottom = Math.min(scrollAreaRect.bottom, footerRect.top);
    const usableScrollRect = {
      ...scrollAreaRect,
      bottom: usableBottom,
      height: Math.max(0, usableBottom - scrollAreaRect.top),
    };
    const style = getComputedStyle(anchor);
    const paddingLeft = Number.parseFloat(style.paddingLeft || "0");
    const paddingRight = Number.parseFloat(style.paddingRight || "0");
    const contentWidth = anchor.clientWidth - paddingLeft - paddingRight;
    const anchorRect = rectOf(anchor);
    const next = computeTodoSidePlacement(
      {
        ...anchorRect,
        left: anchorRect.left + paddingLeft,
        right: anchorRect.right - paddingRight,
        width: contentWidth,
      },
      usableScrollRect,
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlacement(current => current?.left === next?.left && current?.top === next?.top && current?.width === next?.width && current?.maxHeight === next?.maxHeight ? current : next);
  }, []);
  const setCardRef = useCallback((element: HTMLDivElement | null) => {
    cardRef.current = element;
    if (element) {
      footerRef.current ??= element.closest<HTMLElement>("[data-scroll-footer]");
      scrollAreaRef.current ??= footerRef.current ? findComposerScrollArea(footerRef.current) : null;
    }
  }, []);
  useEffect(() => {
    if (!threadId || !visible || !canUseSidePlacement || typeof document === "undefined") { setPlacement(null); return; }
    let frame = 0;
    let observer: ResizeObserver | null = null;
    let observedAnchor: HTMLElement | null = null;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const footer = footerRef.current;
    const scrollArea = scrollAreaRef.current;
    for (const element of [cardRef.current, footer, scrollArea]) {
      if (element) observer?.observe(element);
    }
    const observeContentAnchor = () => {
      const scope = footer?.closest<HTMLElement>("[data-thread-window]") ?? footer?.closest<HTMLElement>("[data-split-pane-id]");
      const next = scope ? Array.from(scope.querySelectorAll<HTMLElement>("[data-message-column]")).reverse().find(column => column.isConnected && column.getBoundingClientRect().height > 0) ?? null : null;
      if (next === observedAnchor) return;
      if (observedAnchor) observer?.unobserve(observedAnchor);
      observedAnchor = next;
      if (observedAnchor) observer?.observe(observedAnchor);
    };
    const scope = footer?.closest<HTMLElement>("[data-thread-window]") ?? footer?.closest<HTMLElement>("[data-split-pane-id]");
    const mutations = scope ? new MutationObserver(() => { observeContentAnchor(); update(); }) : null;
    if (scope) mutations?.observe(scope, { childList: true, subtree: true });
    observeContentAnchor();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [threadId, visible, expanded, canUseSidePlacement, measure, placement]);
  return { cardRef: setCardRef, placement };
}

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
  const { values: settings } = useSettings();
  const hideDelaySeconds = typeof settings?.completedHideDelaySeconds === "number" ? settings.completedHideDelaySeconds : 30;
  const connection = useRealtimeConnectionState();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [hiddenAfterCompletion, setHiddenAfterCompletion] = useState(false);
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
    if (!threadId) { setTasks([]); setError(null); setSnapshotLoaded(false); return; }
    rpc.call("snapshot", { threadId }).then(result => {
      if (generation.current === request) { setTasks(result.tasks); setError(null); setSnapshotLoaded(true); }
    }, cause => {
      if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId]);
  useEffect(() => { setTasks([]); setSnapshotLoaded(false); setOverride(null); refresh(); return () => { generation.current++; }; }, [threadId, refresh]);
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
  const tasksFingerprint = JSON.stringify(tasks);
  useEffect(() => {
    setHiddenAfterCompletion(false);
    if (!threadId || !snapshotLoaded || !card.allComplete || error) return;
    if (hideDelaySeconds === 0) { setHiddenAfterCompletion(true); return; }
    const timer = window.setTimeout(() => setHiddenAfterCompletion(true), hideDelaySeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [threadId, snapshotLoaded, tasksFingerprint, card.allComplete, error, hideDelaySeconds]);
  const auto = autoExpanded(card, view.run.isRunning);
  const expanded = override && override.auto === auto ? override.open : auto;
  const visible = !!threadId && !(hiddenAfterCompletion && card.allComplete && !error) && (card.total > 0 || !!error);
  const { cardRef, placement } = useTodoSidePlacement(
    threadId,
    visible,
    expanded,
    view.scope.kind !== "queued-message",
  );
  if (!visible) return null;
  if (!card.total) {
    const content = <div ref={cardRef} className={`todo-card${placement ? " todo-card-floating" : ""}`} data-floating={placement ? "" : undefined}
      style={placement ? { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight } : undefined}>
      <div className="todo-header todo-header-error" role="alert" title={error ?? undefined}>
        <Icon name="ListTodo" className="todo-header-icon" aria-hidden="true" />
        <span className="todo-summary">Todo timeline unavailable</span>
      </div>
    </div>;
    return placement && typeof document !== "undefined" ? createPortal(content, document.body) : content;
  }
  const working = view.run.isRunning && !card.allComplete;
  const current = currentLabel(card);
  const summary = `${card.completed}/${card.total} complete`;
  const content = <div ref={cardRef} className={`todo-card${card.allComplete ? " todo-card-done" : ""}${placement ? " todo-card-floating" : ""}`}
    data-floating={placement ? "" : undefined}
    style={placement ? { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight } : undefined}>
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
  return placement && typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
export default definePluginApp(app => {
  app.composer.customize({ id: "pi-todo-renderer", scopes: ["thread", "queued-message", "side-chat"], banners: [{ id: "todos", chrome: "bare", component: TodoCard }] });
});
