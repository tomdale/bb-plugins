import { describe, expect, it } from "vitest";
import { extractOneSentenceSummary, runIsWorking, runStatusLabel, summarizeRuns } from "./status.ts";

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

describe("extractOneSentenceSummary", () => {
  it("keeps decimal numbers and versions inside a sentence", () => {
    expect(extractOneSentenceSummary("2.7h run timed out after completing 78 of 120 steps.")).toBe(
      "2.7h run timed out after completing 78 of 120 steps.",
    );
    expect(extractOneSentenceSummary("Upgraded to v1.4.2 successfully.")).toBe("Upgraded to v1.4.2 successfully.");
  });

  it("still returns the last sentence of a longer text", () => {
    expect(extractOneSentenceSummary("Read the files. Found 3.5 MB of logs! Now compressing them.")).toBe(
      "Now compressing them.",
    );
    expect(extractOneSentenceSummary("No terminator here")).toBe("No terminator here.");
  });
});
