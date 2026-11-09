import { describe, expect, it } from "vitest";
import {
  actionCssVariables,
  actionTarget,
  CORNERS,
  hoverCorridorPoints,
  sanitizeCorner,
  sanitizeMotion,
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
