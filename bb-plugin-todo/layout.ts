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
// Below this height the gutter lane would clip its list, so the card stays in the composer.
const TODO_SIDE_MIN_HEIGHT = 180;

/**
 * Places the Todo lane in the gutter to the right of `anchor`. With
 * `followAnchorTop`, the lane starts level with the top of the anchor (the live
 * turn) and then sticks at the top of the scroll area as the turn scrolls past,
 * so it stays beside the work it describes. Without it, the lane is pinned at
 * the top of the scroll area. Either way it never starts so low that its list
 * would be clipped by the composer.
 */
export function computeTodoSidePlacement(
  anchor: TodoRect,
  scrollArea: TodoRect,
  viewport: { width: number; height: number },
  { followAnchorTop = false }: { followAnchorTop?: boolean } = {},
): TodoSidePlacement | null {
  if (anchor.width <= 0 || scrollArea.width <= 0) return null;

  const right = Math.min(scrollArea.right, viewport.width);
  const available = right - anchor.right - TODO_SIDE_GAP - TODO_EDGE_RESERVE;
  const stickyTop = Math.max(TODO_VIEWPORT_INSET, scrollArea.top + TODO_VIEWPORT_INSET);
  const bottom = Math.min(viewport.height, scrollArea.bottom) - TODO_VIEWPORT_INSET;
  if (available < TODO_SIDE_MIN_WIDTH || bottom - stickyTop < TODO_SIDE_MIN_HEIGHT) return null;
  const top = followAnchorTop ? Math.min(Math.max(stickyTop, anchor.top), bottom - TODO_SIDE_MIN_HEIGHT) : stickyTop;
  const maxHeight = bottom - top;

  return {
    left: anchor.right + TODO_SIDE_GAP,
    top,
    width: Math.min(TODO_SIDE_MAX_WIDTH, available),
    maxHeight,
  };
}
