import { describe, expect, it } from "vitest";
import { menuFocusTarget } from "./menu";

describe("menuFocusTarget", () => {
  it("moves with arrows and wraps", () => {
    expect(menuFocusTarget("ArrowDown", 0, 3)).toBe(1);
    expect(menuFocusTarget("ArrowDown", 2, 3)).toBe(0);
    expect(menuFocusTarget("ArrowUp", 0, 3)).toBe(2);
    expect(menuFocusTarget("ArrowUp", 2, 3)).toBe(1);
  });

  it("enters from outside the items at the near end", () => {
    expect(menuFocusTarget("ArrowDown", -1, 3)).toBe(0);
    expect(menuFocusTarget("ArrowUp", -1, 3)).toBe(2);
  });

  it("jumps with Home and End and ignores other keys", () => {
    expect(menuFocusTarget("Home", 2, 3)).toBe(0);
    expect(menuFocusTarget("End", 0, 3)).toBe(2);
    expect(menuFocusTarget("a", 0, 3)).toBeNull();
    expect(menuFocusTarget("ArrowDown", -1, 0)).toBeNull();
  });
});
