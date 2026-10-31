// Where the flag toolbar and note composer sit relative to the page.
//
// The box is placed from measured geometry, never from a guess about line
// height or margins. Every number is a pixel offset from the top-left of the
// page element, which scrolls with its content. The rules, in order; the first
// whose box fits wins:
//
//   1. above    just over the selection, under the top bar and the page heading;
//   2. beside   in the page margin next to the selection's first line, when the
//               margin is wide enough and holds no margin note;
//   3. below    under the line that follows the selection, with a clear gap, so
//               the next line of prose stays readable;
//   4. tight    directly under the selection (the next line is covered) when
//               there is no room for 3;
//   5. over     above the selection but over the heading, when 4 fails;
//   6. pinned   inside the visible area, the last resort for a box taller than
//               the room on either side.
//
// No placement covers the selection itself except "pinned", and none runs under
// the top bar or the pager.

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface FlagGeometry {
  /** The selection's bounds (all of its lines). */
  anchor: Rect;
  /** Bottom of the line that follows the selection's last line; the anchor's bottom when nothing follows or it is unknown. */
  nextLineBottom: number;
  /** The visible band of the page: below the top bar and the page heading, above the pager. */
  visibleTop: number;
  visibleBottom: number;
  /** The top of the reader's scrolling area: the box never goes above it, even over the heading. */
  hardTop: number;
  /** The page's width and the text column inside it (the padding is the margin). */
  pageWidth: number;
  column: { left: number; right: number };
  /** Margin notes and asides the box must not cover. */
  obstacles: readonly Rect[];
}

export interface BoxSize {
  width: number;
  height: number;
}

export type FlagSide = "above" | "beside" | "below" | "tight" | "over" | "pinned";

export interface FlagPosition {
  top: number;
  left: number;
  side: FlagSide;
}

/** Space between the box and the selection. */
export const GAP = 6;
/** Space kept between the box and the next line of prose when it goes below. */
export const CLEARANCE = 4;
/** Space kept from the edges of the visible band and of the page. */
const EDGE = 4;

const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The box's top-left for `size`, and which rule placed it. */
export function placeFlag(geometry: FlagGeometry, size: BoxSize): FlagPosition {
  const { anchor, visibleTop, visibleBottom, hardTop, pageWidth, column } = geometry;
  const { width, height } = size;
  const maxLeft = Math.max(EDGE, pageWidth - width - EDGE);
  const alongSelection = Math.max(EDGE, Math.min(anchor.left, maxLeft));
  const fitsBelow = (top: number) => top + height <= visibleBottom - EDGE;
  const clear = (rect: Rect) => !geometry.obstacles.some((obstacle) => overlaps(rect, obstacle));

  const above = anchor.top - GAP - height;
  if (above >= visibleTop + EDGE) return { top: above, left: alongSelection, side: "above" };

  // Beside: aligned with the selection's first line, as high as the band allows.
  const beside = Math.max(visibleTop + EDGE, Math.min(anchor.top, visibleBottom - EDGE - height));
  const inRight = column.right + GAP;
  const inLeft = column.left - GAP - width;
  const margins: Array<[number, number]> = [
    [inRight, pageWidth - EDGE - (inRight + width)],
    [inLeft, inLeft - EDGE],
  ];
  for (const [left, room] of margins) {
    if (room >= 0 && clear({ top: beside, bottom: beside + height, left, right: left + width })) return { top: beside, left, side: "beside" };
  }

  const below = Math.max(anchor.bottom, geometry.nextLineBottom) + CLEARANCE;
  if (fitsBelow(below)) return { top: below, left: alongSelection, side: "below" };

  const tight = anchor.bottom + GAP;
  if (fitsBelow(tight)) return { top: tight, left: alongSelection, side: "tight" };

  if (above >= hardTop + EDGE) return { top: above, left: alongSelection, side: "over" };

  const lowest = visibleBottom - EDGE - height;
  return { top: Math.max(hardTop + EDGE, Math.min(tight, lowest)), left: alongSelection, side: "pinned" };
}
