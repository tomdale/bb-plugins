import { describe, expect, it } from "vitest";
import { formatDuration, graceMsFor, noticeMessage, scheduleTimeout } from "./timeout.ts";

describe("timeout schedule", () => {
  it("scales the grace period with the timeout within its bounds", () => {
    expect(graceMsFor(60_000)).toBe(30_000);
    expect(graceMsFor(1_800_000)).toBe(180_000);
    expect(graceMsFor(86_400_000)).toBe(600_000);
  });

  it("gives longer runs more heads-up notices before the deadline", () => {
    const at = (seconds: number) => scheduleTimeout(0, seconds * 1000);
    expect(at(60).notices).toEqual([]);
    expect(at(300).notices).toEqual([180_000, 240_000]);
    expect(at(1800).notices).toEqual([1_080_000, 1_440_000]);
    expect(at(86_400).notices).toEqual([86_400_000 - 4_800_000, 86_400_000 - 2_400_000, 86_400_000 - 1_200_000]);
    expect(at(1800).deadline).toBe(1_800_000);
  });

  it("formats durations for a worker to read", () => {
    expect(formatDuration(45_000)).toBe("45 seconds");
    expect(formatDuration(360_000)).toBe("6 minutes");
    expect(formatDuration(7_200_000)).toBe("2 hours");
  });

  it("escalates each time check and reads the budget as an adjective", () => {
    const day = 86_400_000;
    const grace = graceMsFor(day);
    const first = noticeMessage(8 * grace, day, grace);
    const second = noticeMessage(4 * grace, day, grace);
    const third = noticeMessage(2 * grace, day, grace);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toContain("about 80 minutes remain of your 24-hour budget");
    expect(first).toContain("highest-value work");
    expect(second).toContain("about 40 minutes");
    expect(second).toContain("begin finishing");
    expect(third).toContain("about 20 minutes");
    expect(third).toContain("wrap up");
    expect(noticeMessage(180_000, 1_800_000, 180_000)).toContain("your 30-minute budget");
    expect(noticeMessage(90_000, 90_000 * 4, 30_000)).toContain("your 6-minute budget");
  });
});
