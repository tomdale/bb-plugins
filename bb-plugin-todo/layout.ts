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
  /** Distance from the viewport's bottom edge to the bottom of the usable area. */
  bottomInset: number;
  width: number;
  maxHeight: number;
}

export const TODO_SIDE_MIN_WIDTH = 240;
const TODO_SIDE_MAX_WIDTH = 280;
const TODO_SIDE_GAP = 40;
// Keeps the lane off the edge of the scroll area, where it meets the sidebar.
const TODO_EDGE_RESERVE = 24;
const TODO_VIEWPORT_INSET = 16;
const TODO_SIDE_MIN_HEIGHT = 180;

/**
 * Places the Todo lane in the gutter to the left of `anchor`. The result bounds
 * the lane's box to the usable vertical area (`top`, `bottomInset`, `maxHeight`)
 * so CSS can center the lane inside it at its natural height.
 *
 * The vertical position is deliberately constant: a fixed-position lane that
 * tracked a message's top would be repositioned from script after the
 * compositor has already scrolled the content, so it would visibly swim against
 * the text.
 */
export function computeTodoSidePlacement(
  anchor: TodoRect,
  scrollArea: TodoRect,
  viewport: { width: number; height: number },
): TodoSidePlacement | null {
  if (anchor.width <= 0 || scrollArea.width <= 0) return null;

  const left = Math.max(scrollArea.left, 0);
  const available = anchor.left - left - TODO_SIDE_GAP - TODO_EDGE_RESERVE;
  const top = Math.max(TODO_VIEWPORT_INSET, scrollArea.top + TODO_VIEWPORT_INSET);
  const bottom = Math.min(viewport.height, scrollArea.bottom) - TODO_VIEWPORT_INSET;
  const maxHeight = bottom - top;
  if (available < TODO_SIDE_MIN_WIDTH || maxHeight < TODO_SIDE_MIN_HEIGHT) return null;

  const width = Math.min(TODO_SIDE_MAX_WIDTH, available);
  return {
    left: anchor.left - TODO_SIDE_GAP - width,
    top,
    bottomInset: viewport.height - bottom,
    width,
    maxHeight,
  };
}
