import { describe, expect, it } from "vitest";
import { CLEARANCE, GAP, placeFlag, type FlagGeometry, type Rect } from "../src/ui/place-flag.ts";

const LINE = 27;
const BAR = { width: 215, height: 32 };
const COMPOSER = { width: 300, height: 190 };

/** A wide page: a 1080px sheet, a 62px ruled margin, an empty 260px right margin. */
function wide(over: Partial<FlagGeometry> & { top?: number; height?: number; left?: number; right?: number } = {}): FlagGeometry {
  const top = over.top ?? 300;
  const height = over.height ?? 22;
  return {
    anchor: { top, bottom: top + height, left: over.left ?? 200, right: over.right ?? 260 },
    nextLineBottom: top + height + LINE,
    visibleTop: 100,
    visibleBottom: 700,
    hardTop: 40,
    pageWidth: 1080,
    column: { left: 62, right: 820 },
    obstacles: [],
    ...over,
  };
}
/** A panel-width page: 480px with a 62px and a 22px margin. */
function narrow(over: Partial<FlagGeometry> & { top?: number; height?: number; left?: number; right?: number } = {}): FlagGeometry {
  return { ...wide(over), pageWidth: 480, column: { left: 62, right: 458 }, ...over };
}

const box = (geometry: FlagGeometry, size = BAR) => {
  const position = placeFlag(geometry, size);
  const rect: Rect = { top: position.top, bottom: position.top + size.height, left: position.left, right: position.left + size.width };
  return { ...position, rect };
};
const crosses = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const selectionOf = (g: FlagGeometry) => g.anchor;

describe("placing the flag toolbar", () => {
  it("sits just above a selection in the middle of the page", () => {
    const placed = box(wide());
    expect(placed).toMatchObject({ side: "above", top: 300 - GAP - BAR.height, left: 200 });
  });

  it("sits above a selection on the last visible line, clear of the pager", () => {
    const placed = box(wide({ top: 660 }));
    expect(placed.side).toBe("above");
    expect(placed.rect.bottom).toBeLessThanOrEqual(660);
  });

  it("keeps the left edge on the selection, and inside the page on the right", () => {
    expect(box(narrow({ top: 300, left: 5 })).left).toBe(5);
    expect(box(narrow({ top: 300, left: 2 })).left).toBe(4);
    expect(box(narrow({ top: 300, left: 450 })).left).toBe(480 - BAR.width - 4);
  });

  describe("a selection at the top of the page, under the heading", () => {
    // The heading is above: visibleTop is its bottom, so there is no room above.
    const top = { top: 108, visibleTop: 100 };

    it("goes beside the selection, in the margin, on a wide page", () => {
      const placed = box(wide(top));
      expect(placed.side).toBe("beside");
      expect(placed.left).toBe(820 + GAP);
      expect(placed.rect.right).toBeLessThanOrEqual(1080 - 4);
      expect(placed.top).toBe(108);
      expect(crosses(placed.rect, selectionOf(wide(top)))).toBe(false);
    });

    it("uses the left margin when the right one holds a margin note", () => {
      const note: Rect = { top: 90, bottom: 400, left: 840, right: 1050 };
      const placed = box(wide({ ...top, obstacles: [note], column: { left: 262, right: 820 } }));
      expect(placed.side).toBe("beside");
      expect(placed.rect.right).toBeLessThanOrEqual(262 - GAP);
    });

    it("drops below the line under the selection when the margins are taken, never covering that line", () => {
      const note: Rect = { top: 90, bottom: 400, left: 840, right: 1050 };
      const geometry = wide({ ...top, obstacles: [note] });
      const placed = box(geometry);
      expect(placed.side).toBe("below");
      expect(placed.top).toBeGreaterThanOrEqual(geometry.nextLineBottom + CLEARANCE);
      expect(crosses(placed.rect, { top: geometry.anchor.bottom, bottom: geometry.nextLineBottom, left: 0, right: 1080 })).toBe(false);
    });

    it("drops below the line under the selection on a narrow page", () => {
      const geometry = narrow(top);
      const placed = box(geometry);
      expect(placed.side).toBe("below");
      expect(placed.top).toBe(geometry.nextLineBottom + CLEARANCE);
      expect(placed.top).toBe(108 + 22 + LINE + CLEARANCE);
      expect(crosses(placed.rect, selectionOf(geometry))).toBe(false);
    });

    it("never starts above the visible top, so the heading and top bar stay uncovered", () => {
      for (const g of [wide(top), narrow(top), narrow({ top: 104, visibleTop: 100 })]) expect(box(g).top).toBeGreaterThanOrEqual(g.visibleTop);
    });
  });

  it("goes beside the selection only when the margin is wide enough for the box", () => {
    // 62px and 22px margins: a 215px toolbar cannot sit in either.
    expect(box(narrow({ top: 108 })).side).toBe("below");
    // The composer is wider, and a 260px margin still cannot hold it.
    expect(box(wide({ top: 108 }), COMPOSER).side).toBe("below");
  });

  it("covers the next line only when nothing else fits below and keeps the selection clear", () => {
    // Room for the toolbar directly under the selection but not under the next line.
    const geometry = narrow({ top: 108, visibleBottom: 108 + 22 + 6 + BAR.height + 8 });
    const placed = box(geometry);
    expect(placed.side).toBe("tight");
    expect(placed.top).toBe(geometry.anchor.bottom + GAP);
    expect(crosses(placed.rect, selectionOf(geometry))).toBe(false);
  });

  it("goes over the heading, not the selection, when below has no room and above does", () => {
    const geometry = narrow({ top: 108, visibleTop: 100, visibleBottom: 130, hardTop: 40 });
    const placed = box(geometry);
    expect(placed.side).toBe("over");
    expect(placed.rect.bottom).toBeLessThanOrEqual(108);
  });

  it("pins a box taller than the room on either side inside the visible band", () => {
    const geometry = narrow({ top: 300, height: 390, visibleTop: 100, visibleBottom: 700, hardTop: 100 });
    const placed = box(geometry, { width: 300, height: 420 });
    expect(placed.side).toBe("pinned");
    expect(placed.top).toBeGreaterThanOrEqual(104);
    expect(placed.rect.bottom).toBeLessThanOrEqual(700);
  });

  describe("a multi-line selection", () => {
    it("goes above the first line and aligns with it", () => {
      const geometry = wide({ top: 300, height: 27 * 3 });
      const placed = box(geometry);
      expect(placed).toMatchObject({ side: "above", top: 300 - GAP - BAR.height });
    });

    it("drops below its last line, under the line that follows, when it starts at the top", () => {
      const geometry = narrow({ top: 108, height: 22 + 27 * 2 });
      const placed = box(geometry);
      expect(placed.side).toBe("below");
      expect(placed.top).toBe(geometry.nextLineBottom + CLEARANCE);
      expect(placed.top).toBeGreaterThan(geometry.anchor.bottom);
    });

    it("sits beside the first line on a wide page and clears every selected line", () => {
      const geometry = wide({ top: 108, height: 22 + 27 * 2, left: 62, right: 820 });
      const placed = box(geometry);
      expect(placed.side).toBe("beside");
      expect(crosses(placed.rect, selectionOf(geometry))).toBe(false);
    });
  });

  it("never runs under the pager or the top bar for any selection height or position", () => {
    for (const geometryOf of [wide, narrow]) {
      for (const size of [BAR, COMPOSER]) {
        for (let top = 104; top <= 690; top += 17) {
          for (const height of [22, 49, 140]) {
            const geometry = geometryOf({ top, height });
            const placed = box(geometry, size);
            if (placed.side === "pinned" || placed.side === "over") continue;
            expect(placed.rect.top, `${geometryOf.name} ${size.height} @${top}+${height}`).toBeGreaterThanOrEqual(geometry.visibleTop);
            expect(placed.rect.bottom).toBeLessThanOrEqual(geometry.visibleBottom);
            expect(crosses(placed.rect, selectionOf(geometry))).toBe(false);
          }
        }
      }
    }
  });
});
