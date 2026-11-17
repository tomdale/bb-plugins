import { describe, expect, it } from "vitest";
import { formatDuration, graceMsFor, scheduleTimeout } from "./timeout.ts";

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
});
