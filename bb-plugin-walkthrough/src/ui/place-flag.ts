// Where the flag toolbar and note composer sit relative to the page: beside
// the selection, but never outside what the reader can see. All numbers are
// pixels from the top of the page element, which scrolls with its content.

export interface FlagPlacement {
  /** The selection's top and bottom. */
  anchorTop: number;
  anchorBottom: number;
  /** What is visible of the page right now: below the top bar, above the pager. */
  visibleTop: number;
  visibleBottom: number;
}

const GAP = 6;
const EDGE = 4;

/**
 * The top edge for a box of `height`: above the selection when it fits there,
 * else below it, else pinned inside the visible area (a selection taller than
 * the view, or a box taller than the room on either side).
 */
export function flagTop(place: FlagPlacement, height: number): number {
  const above = place.anchorTop - GAP - height;
  if (above >= place.visibleTop + EDGE) return above;
  const below = place.anchorBottom + GAP;
  if (below + height <= place.visibleBottom - EDGE) return below;
  const lowest = place.visibleBottom - EDGE - height;
  return Math.max(place.visibleTop + EDGE, Math.min(below, lowest));
}
