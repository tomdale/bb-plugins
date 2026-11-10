import { describe, expect, it } from "vitest";
import { exportFileName } from "./file-name.js";

describe("exportFileName", () => {
  it("reads like the thread title, with a short id and the date", () => {
    const name = exportFileName("Fix the flaky, flaky test!", "thr_demo5aaaaa");
    expect(name).toMatch(/^fix-the-flaky-flaky-test-demo5aaa-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it("folds accents instead of dropping the letters", () => {
    expect(exportFileName("Café résumé", "thr_1")).toMatch(/^cafe-resume-/);
  });

  it("falls back to a neutral name for an untitled thread", () => {
    expect(exportFileName("", "thr_ab")).toMatch(/^bb-thread-ab-\d{4}-\d{2}-\d{2}\.html$/);
    expect(exportFileName(null, "")).toMatch(/^bb-thread-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it("bounds the title so the name stays usable", () => {
    const name = exportFileName("a".repeat(200), "thr_x");
    expect(name.length).toBeLessThan(100);
  });
});
