import { describe, expect, it } from "vitest";
import {
  actionCssVariables,
  actionTarget,
  CORNERS,
  cursorActionCssVariables,
  cursorActionTarget,
  hoverCorridorPoints,
  PIE_HUB_RADIUS_PX,
  PIE_ITEM_RADIUS_PX,
  PIE_ITEM_START_RADIUS_PX,
  PIE_RADIUS_PX,
  pieSliceAt,
  pieSlicePath,
  sanitizeCorner,
  sanitizeMotion,
  sanitizeTrigger,
} from "./motion";

describe("settings sanitization", () => {
  it("accepts every supported corner and motion", () => {
    for (const corner of CORNERS) expect(sanitizeCorner(corner)).toBe(corner);
    expect(sanitizeMotion("ring")).toBe("ring");
    expect(sanitizeMotion("arc")).toBe("arc");
  });

  it("falls back field-by-field for unknown stored values", () => {
    expect(sanitizeCorner("middle")).toBe("bottom-left");
    expect(sanitizeCorner(undefined)).toBe("bottom-left");
    expect(sanitizeMotion("direct-pop")).toBe("ring");
    expect(sanitizeMotion(null)).toBe("ring");
    expect(sanitizeTrigger("spotlight")).toBe("hold-option");
    expect(sanitizeTrigger(undefined)).toBe("hold-option");
    expect(sanitizeTrigger("corner")).toBe("corner");
  });
});

describe("motion geometry", () => {
  it("connects the trigger to each action with a radial corridor", () => {
    const target = actionTarget(0, 5, "bottom-left");
    const ux = target.x / 116;
    const uy = target.y / 116;
    const points = hoverCorridorPoints(target);
    expect(points.split(" ")).toHaveLength(4);
    expect(points.split(" ")[0]).toBe(
      `${(16 * (ux - uy)).toFixed(2)},${(16 * (uy + ux)).toFixed(2)}`,
    );
  });

  it("mirrors the arc into every corner without changing its radius", () => {
    const bottomLeft = actionTarget(0, 5, "bottom-left");
    for (const corner of CORNERS) {
      const point = actionTarget(0, 5, corner);
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(
        Math.hypot(bottomLeft.x, bottomLeft.y),
      );
    }
    expect(actionTarget(0, 5, "bottom-right").x).toBe(-bottomLeft.x);
    expect(actionTarget(0, 5, "top-left").y).toBe(-bottomLeft.y);
  });

  it("provides transform coordinates and stagger delays to CSS", () => {
    const target = actionTarget(2, 5, "top-right");
    const style = actionCssVariables({
      index: 2,
      count: 5,
      corner: "top-right",
    }) as Record<string, string>;
    expect(style["--qa-action-x"]).toBe(`${target.x}px`);
    expect(style["--qa-action-y"]).toBe(`${target.y}px`);
    expect(style["--qa-open-delay"]).toBe("24ms");
  });
});

describe("hold-Option geometry", () => {
  it("spreads the fan evenly from twelve o'clock", () => {
    const first = cursorActionTarget(0, 5);
    expect(first.x).toBeCloseTo(0);
    expect(first.y).toBeCloseTo(-PIE_ITEM_RADIUS_PX);
    const second = cursorActionTarget(1, 5);
    expect(Math.hypot(second.x, second.y)).toBeCloseTo(PIE_ITEM_RADIUS_PX);
    const angles = [0, 1, 2, 3, 4].map((index) => {
      const target = cursorActionTarget(index, 5);
      return Math.atan2(target.y, target.x);
    });
    for (let index = 1; index < angles.length; index += 1) {
      const step = angles[index]! - angles[index - 1]!;
      const wrapped = ((step % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      expect(wrapped).toBeCloseTo((Math.PI * 2) / 5);
    }
  });

  it("staggers the same way as the corner fan", () => {
    const style = cursorActionCssVariables({ index: 3, count: 5 }) as Record<
      string,
      string
    >;
    const target = cursorActionTarget(3, 5);
    expect(style["--qa-action-x"]).toBe(`${target.x}px`);
    expect(style["--qa-action-y"]).toBe(`${target.y}px`);
    expect(style["--qa-open-delay"]).toBe("36ms");
  });

  it("selects the slice the pointer points into", () => {
    expect(pieSliceAt({ x: 0, y: -60 }, 5)).toBe(0);
    expect(pieSliceAt({ x: 0, y: -PIE_HUB_RADIUS_PX + 1 }, 5)).toBeNull();
    for (let index = 0; index < 5; index += 1) {
      const target = cursorActionTarget(index, 5);
      expect(pieSliceAt(target, 5)).toBe(index);
    }
    // Just short of the boundary between slice 4 and slice 0.
    const near = (-Math.PI * 2) / 10 + 0.01;
    expect(pieSliceAt({ x: Math.sin(near) * 80, y: -Math.cos(near) * 80 }, 5)).toBe(0);
  });

  it("draws one slice from the hub's edge to the rim", () => {
    const path = pieSlicePath(4);
    const f = (value: number) => value.toFixed(2);
    const inner = Math.sin(Math.PI / 4) * PIE_HUB_RADIUS_PX;
    const outer = Math.sin(Math.PI / 4) * PIE_RADIUS_PX;
    expect(path.startsWith(`M -${f(inner)} -${f(inner)} L -${f(outer)} -${f(outer)}`)).toBe(true);
    expect(path).toContain(`A ${PIE_RADIUS_PX} ${PIE_RADIUS_PX} 0 0 1 ${f(outer)} -${f(outer)}`);
    expect(path).toContain(`A ${PIE_HUB_RADIUS_PX} ${PIE_HUB_RADIUS_PX} 0 0 0`);
  });

  it("flies each item out from clear of the hub and closes in reverse order", () => {
    const style = cursorActionCssVariables({ index: 1, count: 5 }) as Record<string, string>;
    const start = cursorActionTarget(1, 5, PIE_ITEM_START_RADIUS_PX);
    expect(style["--qa-action-from-x"]).toBe(`${start.x}px`);
    expect(style["--qa-action-from-y"]).toBe(`${start.y}px`);
    expect(style["--qa-close-delay"]).toBe("36ms");
    expect(PIE_ITEM_START_RADIUS_PX - 21 * 0.7).toBeGreaterThan(PIE_HUB_RADIUS_PX);
  });
});
