import { describe, expect, it } from "vitest";
import { computeTodoSidePlacement, TODO_SIDE_MIN_WIDTH } from "./layout.js";

const rect = (left: number, right: number, top = 0, bottom = 700) => ({
  left, right, top, bottom, width: right - left, height: bottom - top,
});

describe("computeTodoSidePlacement", () => {
  it("measures the content edge before placement instead of the padded message column edge", () => {
    expect(computeTodoSidePlacement(
      { ...rect(120, 900), right: 884, width: 764 },
      rect(0, 1500),
      { width: 1500, height: 900 },
    )).toEqual({ left: 896, top: 16, width: 320, maxHeight: 668 });
  });

  it("uses only the gutter to the right of the composer content and caps the card width", () => {
    expect(computeTodoSidePlacement(
      rect(120, 880, 560, 640),
      rect(0, 1500),
      { width: 1500, height: 900 },
    )).toEqual({ left: 892, top: 16, width: 320, maxHeight: 668 });
  });

  it("leaves the banner in the composer when the measured gutter is too narrow", () => {
    expect(computeTodoSidePlacement(
      rect(120, 880),
      rect(0, 1200),
      { width: 1200, height: 900 },
    )).toBeNull();
    expect(computeTodoSidePlacement(
      rect(0, 500),
      rect(0, 1000),
      { width: 820, height: 900 },
    )).toBeNull();
  });

  it("reserves an edge gutter for adjacent fixed navigation widgets", () => {
    expect(computeTodoSidePlacement(
      rect(120, 900),
      rect(0, 1231),
      { width: 1320, height: 900 },
    )).toBeNull();
  });

  it("does not use space outside the active scroll area or viewport", () => {
    const anchor = rect(100, 700);
    expect(computeTodoSidePlacement(anchor, rect(0, 1040), { width: 1020, height: 800 })).toBeNull();
    expect(computeTodoSidePlacement(anchor, rect(0, 1500), { width: 1020, height: 800 })).toBeNull();
  });

  it("requires usable vertical space and clamps the card to the thread's vertical bounds", () => {
    expect(computeTodoSidePlacement(rect(0, 100), rect(0, 1000, 0, 200), { width: 1000, height: 900 })).toBeNull();
    expect(computeTodoSidePlacement(rect(0, 100), rect(0, 100 + 12 + 40 + TODO_SIDE_MIN_WIDTH, 120, 600), { width: 1000, height: 900 }))
      .toEqual({ left: 112, top: 136, width: TODO_SIDE_MIN_WIDTH, maxHeight: 448 });
  });
});
