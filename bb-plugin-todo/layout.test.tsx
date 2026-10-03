import { describe, expect, it } from "vitest";
import { computeTodoSidePlacement, TODO_SIDE_MIN_WIDTH } from "./layout.js";

const rect = (left: number, right: number, top = 0, bottom = 700) => ({
  left, right, top, bottom, width: right - left, height: bottom - top,
});

describe("computeTodoSidePlacement", () => {
  it("measures the content edge before placement instead of the padded message column edge", () => {
    expect(computeTodoSidePlacement(
      { ...rect(400, 1100), left: 416, width: 668 },
      rect(0, 1500),
      { width: 1500, height: 900 },
    )).toEqual({ left: 24, top: 16, bottomInset: 216, width: 280, maxHeight: 668 });
  });

  it("uses only the gutter to the left of the message column and caps the lane width", () => {
    expect(computeTodoSidePlacement(
      rect(600, 1300, 560, 640),
      rect(0, 1500),
      { width: 1500, height: 900 },
    )).toEqual({ left: 200, top: 16, bottomInset: 216, width: 280, maxHeight: 668 });
  });

  it("gives the gap to the text as much of the gutter as it can, up to 120px, before shrinking the lane", () => {
    const place = (anchorLeft: number) => computeTodoSidePlacement(rect(anchorLeft, anchorLeft + 700), rect(0, 1600), { width: 1600, height: 900 });
    const gapOf = (placement: NonNullable<ReturnType<typeof place>>, anchorLeft: number) => anchorLeft - (placement.left + placement.width);
    expect(gapOf(place(600)!, 600)).toBe(120);
    expect(gapOf(place(400)!, 400)).toBe(96);
    expect(place(400)).toMatchObject({ left: 24, width: 280 });
    // Past its minimum gap of 72px the lane gives up width, down to its own minimum.
    expect(place(346)).toMatchObject({ left: 24, width: 250 });
    expect(gapOf(place(346)!, 346)).toBe(72);
  });

  it("leaves the banner in the composer when the measured gutter is too narrow", () => {
    expect(computeTodoSidePlacement(
      rect(300, 1000),
      rect(0, 1200),
      { width: 1200, height: 900 },
    )).toBeNull();
    expect(computeTodoSidePlacement(
      rect(0, 500),
      rect(0, 1000),
      { width: 820, height: 900 },
    )).toBeNull();
  });

  it("reserves an edge gutter next to the sidebar", () => {
    expect(computeTodoSidePlacement(rect(350, 1000), rect(0, 1500), { width: 1500, height: 900 })).not.toBeNull();
    expect(computeTodoSidePlacement(rect(350, 1000), rect(60, 1500), { width: 1500, height: 900 })).toBeNull();
  });

  it("does not use space outside the viewport", () => {
    expect(computeTodoSidePlacement(rect(300, 1000), rect(-200, 1500), { width: 1500, height: 900 })).toBeNull();
    expect(computeTodoSidePlacement(rect(500, 1000), rect(-200, 1500), { width: 1500, height: 900 }))
      .toEqual({ left: 100, top: 16, bottomInset: 216, width: 280, maxHeight: 668 });
  });

  it("requires usable vertical space and bounds the lane to the thread's vertical area", () => {
    expect(computeTodoSidePlacement(rect(500, 900), rect(0, 1000, 0, 200), { width: 1000, height: 900 })).toBeNull();
    expect(computeTodoSidePlacement(rect(72 + 24 + TODO_SIDE_MIN_WIDTH, 900), rect(0, 1000, 120, 600), { width: 1000, height: 900 }))
      .toEqual({ left: 24, top: 136, bottomInset: 316, width: TODO_SIDE_MIN_WIDTH, maxHeight: 448 });
  });
});
