export interface TodoRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TodoSidePlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export const TODO_SIDE_MIN_WIDTH = 280;
const TODO_SIDE_MAX_WIDTH = 320;
const TODO_SIDE_GAP = 12;
// Leave room for narrow timeline affordances that sit just outside the scroll area.
const TODO_EDGE_RESERVE = 40;
const TODO_VIEWPORT_INSET = 16;

/**
 * Places the Todo lane in the gutter to the right of `anchor`, pinned to the top
 * of the scroll area. The vertical position is deliberately constant: a
 * fixed-position lane that tracked a message's top would be repositioned from
 * script after the compositor has already scrolled the content, so it would
 * visibly swim against the text.
 */
export function computeTodoSidePlacement(
  anchor: TodoRect,
  scrollArea: TodoRect,
  viewport: { width: number; height: number },
): TodoSidePlacement | null {
  if (anchor.width <= 0 || scrollArea.width <= 0) return null;

  const right = Math.min(scrollArea.right, viewport.width);
  const available = right - anchor.right - TODO_SIDE_GAP - TODO_EDGE_RESERVE;
  const top = Math.max(TODO_VIEWPORT_INSET, scrollArea.top + TODO_VIEWPORT_INSET);
  const bottom = Math.min(viewport.height, scrollArea.bottom) - TODO_VIEWPORT_INSET;
  const maxHeight = bottom - top;
  if (available < TODO_SIDE_MIN_WIDTH || maxHeight < 180) return null;

  return {
    left: anchor.right + TODO_SIDE_GAP,
    top,
    width: Math.min(TODO_SIDE_MAX_WIDTH, available),
    maxHeight,
  };
}
