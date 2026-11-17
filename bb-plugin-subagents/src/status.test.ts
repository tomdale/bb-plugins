import { describe, expect, it } from "vitest";
import { runIsWorking, runStatusLabel, summarizeRuns } from "./status.ts";

describe("winding-down runs", () => {
  it("still count as working and say what they are doing", () => {
    expect(runIsWorking({ status: "winding-down" })).toBe(true);
    expect(runStatusLabel({ status: "winding-down" })).toBe("Wrapping up");
    expect(summarizeRuns([{ status: "winding-down" }, { status: "timed-out" }])).toMatchObject({
      working: 1,
      failed: 1,
    });
  });
});
