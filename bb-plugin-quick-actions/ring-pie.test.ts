import { describe, expect, it } from "vitest";
import { fitRing, pointerAngle, ringType, slotOf } from "./ring-pie";

describe("ring selection", () => {
  it("measures angles clockwise from twelve o'clock", () => {
    expect(pointerAngle(0, -10)).toBeCloseTo(0);
    expect(pointerAngle(10, 0)).toBeCloseTo(90);
    expect(pointerAngle(0, 10)).toBeCloseTo(180);
    expect(pointerAngle(-10, 0)).toBeCloseTo(270);
  });

  it("selects the nearest slot and wraps the short way at twelve", () => {
    expect(slotOf(0, 5)).toBe(0);
    expect(slotOf(35, 5)).toBe(0);
    expect(slotOf(37, 5)).toBe(1);
    expect(slotOf(355, 5)).toBe(0);
    expect(slotOf(320, 5)).toBe(4);
    for (let n = 2; n <= 10; n += 1) {
      for (let i = 0; i < n; i += 1) expect(slotOf((i * 360) / n, n)).toBe(i);
    }
  });

  it("steps label type down as slots narrow", () => {
    expect(ringType(5).font).toBe(12);
    expect(ringType(8).icon).toBe(18);
    expect(ringType(10)).toEqual({ font: 11, icon: 16, gap: 4, wrap: 72 });
  });
});

describe("ring geometry", () => {
  it("keeps the base radii when the labels already fit", () => {
    const small = Array.from({ length: 5 }, () => ({ width: 30, height: 30 }));
    expect(fitRing(5, small)).toEqual({ Rd: 126, ri: 78 });
  });

  it("grows the ring until a wide selected label fits its tile", () => {
    // "Mark unread" in the selected weight, before the 1.06 grow.
    const boxes = Array.from({ length: 6 }, () => ({ width: 82, height: 38 }));
    const fit = fitRing(6, boxes);
    expect(fit.ri).toBeGreaterThan(80);
    expect(fit.Rd).toBeGreaterThan(126);
    // The grown label's inner corners stay inside the 60° tile.
    const half = (82 * 1.06) / 2;
    const innerY = fit.ri - (38 * 1.06) / 2;
    expect(Math.atan2(half, innerY) * (180 / Math.PI)).toBeLessThan(30);
  });

  it("wraps the outermost label with the disc", () => {
    const boxes = Array.from({ length: 10 }, () => ({ width: 72, height: 36 }));
    const fit = fitRing(10, boxes);
    expect(fit.Rd).toBeGreaterThanOrEqual(fit.ri + 18);
  });
});
