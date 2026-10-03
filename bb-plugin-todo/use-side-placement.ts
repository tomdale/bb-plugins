import { useCallback, useEffect, useRef, useState } from "react";
import { computeTodoSidePlacement, type TodoRect, type TodoSidePlacement } from "./layout.js";

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

/**
 * Measures whether the Todo card fits in the thread's right gutter beside the
 * latest visible message column, and returns fixed coordinates when it does.
 * Null keeps the card inline in the composer. The lane is pinned to the top of
 * the scroll area. The measurement follows resizes, scrolls, and timeline
 * mutations because any of them can move the anchor column.
 */
export function useTodoSidePlacement(
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
    // Every message column shares the same horizontal edges, so any mounted column locates the gutter. Prefer
    // visible ones, but keep the lane in the gutter while a tall tool output or windowed-out range leaves none
    // on screen; falling back to the composer there would make the card jump between the two places.
    const measurable = columns.filter(column => {
      const rect = column.getBoundingClientRect();
      return column.isConnected && rect.width > 0 && rect.height > 0;
    });
    const visibleColumns = measurable.filter(column => {
      const rect = column.getBoundingClientRect();
      return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
    });
    const candidates = visibleColumns.length ? visibleColumns : measurable;
    // User-message columns have no inset while prose columns do, so their content edges differ by the inset.
    // Preferring inset columns keeps the lane from shifting as the nearest column changes kind.
    const anchor = candidates.find(column => Number.parseFloat(getComputedStyle(column).paddingRight || "0") > 0) ?? candidates[0];
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
