import { describe, expect, it } from "vitest";
import { snoozePresets } from "./snooze-presets";

const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe("snoozePresets", () => {
  it("offers five presets on a weekday morning, Tomorrow the default", () => {
    // Wednesday 11 November 2026, 10:40.
    const presets = snoozePresets(new Date(2026, 10, 11, 10, 40, 25));
    expect(presets.map((p) => [p.id, p.wakeAt])).toEqual([
      ["hour", local(2026, 11, 11, 11, 40)],
      ["evening", local(2026, 11, 11, 18)],
      ["tomorrow", local(2026, 11, 12, 9)],
      ["weekend", local(2026, 11, 14, 9)],
      ["week", local(2026, 11, 16, 9)],
    ]);
    expect(presets.filter((p) => p.isDefault).map((p) => p.id)).toEqual(["tomorrow"]);
  });

  it("drops This evening from 5 PM", () => {
    const ids = snoozePresets(new Date(2026, 10, 11, 17, 0)).map((p) => p.id);
    expect(ids).toEqual(["hour", "tomorrow", "weekend", "week"]);
  });

  it("drops This weekend from Friday, when Saturday is tomorrow", () => {
    const ids = snoozePresets(new Date(2026, 10, 13, 15, 0)).map((p) => p.id);
    expect(ids).toEqual(["hour", "evening", "tomorrow", "week"]);
  });

  it("drops Next week on Sunday, when Monday is tomorrow", () => {
    const presets = snoozePresets(new Date(2026, 10, 15, 11, 0));
    expect(presets.map((p) => p.id)).toEqual(["hour", "evening", "tomorrow"]);
    expect(presets.at(-1)?.wakeAt).toBe(local(2026, 11, 16, 9));
  });
});
