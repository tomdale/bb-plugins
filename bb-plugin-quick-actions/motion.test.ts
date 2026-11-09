import { describe, expect, it } from "vitest";
import {
  actionFrame,
  actionTarget,
  CORNERS,
  MENU_DURATION_MS,
  sanitizeCorner,
  sanitizeMotion,
  spring,
  triggerRotation,
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

describe("motion frames", () => {
  it("settles every spring and the trigger exactly", () => {
    expect(spring(0)).toBe(0);
    expect(spring(1)).toBe(1);
    expect(spring(0.5)).toBeGreaterThan(0.8);
    expect(triggerRotation(MENU_DURATION_MS, false)).toBe(45);
    expect(triggerRotation(MENU_DURATION_MS, true)).toBe(0);
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

  it("staggers arc items from the trigger", () => {
    const first = actionFrame({
      motion: "arc",
      index: 0,
      count: 5,
      corner: "bottom-left",
      time: 80,
      reducedMotion: false,
    });
    const last = actionFrame({
      motion: "arc",
      index: 4,
      count: 5,
      corner: "bottom-left",
      time: 80,
      reducedMotion: false,
    });
    expect(first.opacity).toBeGreaterThan(0);
    expect(last.opacity).toBe(0);
    const target = actionTarget(0, 5, "bottom-left");
    expect(first.transform).not.toBe(
      `translate(${target.x}px, ${target.y}px) scale(1)`,
    );
  });

  it("moves ring items together as one group", () => {
    const frames = [0, 1, 2].map((index) =>
      actionFrame({
        motion: "ring",
        index,
        count: 3,
        corner: "bottom-left",
        time: 160,
        reducedMotion: false,
      }),
    );
    expect(new Set(frames.map((frame) => frame.opacity)).size).toBe(1);
    expect(frames.every((frame) => frame.opacity > 0)).toBe(true);
  });

  it("uses final positions with only opacity under reduced motion", () => {
    const target = actionTarget(2, 5, "top-right");
    const frame = actionFrame({
      motion: "arc",
      index: 2,
      count: 5,
      corner: "top-right",
      time: 60,
      reducedMotion: true,
    });
    expect(frame.transform).toBe(`translate(${target.x}px, ${target.y}px)`);
    expect(frame.opacity).toBe(0.5);
  });
});
