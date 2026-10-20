import { describe, expect, it } from "vitest";
import { blankTarget, comparedWith, linesText, locationChoices, noteButtonPosition, noteLocation, targetFromDraft, defaultExcerptView, excerptCode, formatStarted, hasChangedLines, parseCommand, renderNotesMarkdown, shortRef, statusLabel, summaryDetail } from "../src/model.ts";
import { filterPatchToRange } from "../src/patch.ts";
import type { Note, Walkthrough } from "../src/schemas.ts";

function walkthrough(overrides: Partial<Walkthrough> = {}): Walkthrough {
  const part = (title: string) => ({ title, summary: "", locations: [], status: "pending" as const, blocks: [], suggestions: [], message: null, discussion: [] });
  return {
    id: "wt_1",
    threadId: "thr_1",
    workerThreadId: "thr_w",
    request: "Walk me through it",
    status: "reading",
    message: null,
    title: "Branch feature",
    mode: "local",
    baseRef: "origin/main",
    includeUncommitted: true,
    pr: null,
    introduction: "",
    parts: ["Schema", "Store", "UI"].map(part),
    currentPart: 0,
    wrapUp: null,
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/w",
    notesFile: { enabled: true, path: "/w/.agent/review-notes.md", written: false, error: null },
    review: null,
    queue: [],
    inFlight: null,
    nextNoteNumber: 1,
    nextExchangeNumber: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function note(overrides: Partial<Note>): Note {
  return {
    id: "n1",
    walkthroughId: "wt_1",
    kind: "question",
    text: "Why?",
    groupIndex: 0,
    location: null,
    quote: null,
    status: "open",
    resolution: null,
    author: "user",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("parseCommand", () => {
  it("records dotted notes and treats everything else as a question", () => {
    expect(parseCommand(".todo rename the cache")).toEqual({ kind: "record", noteKind: "todo", text: "rename the cache" });
    expect(parseCommand(".question")).toEqual({ kind: "incomplete", noteKind: "question" });
    expect(parseCommand("why .todo?")).toEqual({ kind: "text", text: "why .todo?" });
    expect(parseCommand(".next")).toEqual({ kind: "text", text: ".next" });
  });
});

describe("renderNotesMarkdown", () => {
  it("renders nonempty sections with loci and a resolved section", () => {
    const markdown = renderNotesMarkdown(walkthrough(), [
      note({ id: "n1", location: { path: "src/a.ts", startLine: 3, endLine: 9 } }),
      note({ id: "n2", kind: "todo", text: "Rename", groupIndex: null }),
      note({ id: "n3", status: "resolved", resolution: "Because." }),
    ]);
    expect(markdown).toContain("# Review Notes");
    expect(markdown).toContain("## Questions\n\n- [Schema · src/a.ts:3-9] Why? (n1)");
    expect(markdown).toContain("## Todos\n\n- Rename (n2)");
    expect(markdown).not.toContain("## Comments");
    expect(markdown).toContain("## Resolved / Answered\n\n- [Question · Schema] Why? (n3)\n  Answer: Because.");
  });
});

describe("filterPatchToRange", () => {
  const patch = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,3 +1,4 @@",
    " a",
    "+b",
    " c",
    "@@ -40,1 +41,2 @@",
    " x",
    "+y",
    "",
  ].join("\n");

  it("keeps only hunks intersecting the range", () => {
    const result = filterPatchToRange(patch, 41, 42);
    expect(result.filtered).toBe(true);
    expect(result.patch).toContain("@@ -40,1 +41,2 @@");
    expect(result.patch).not.toContain("@@ -1,3 +1,4 @@");
    expect(result.patch.startsWith("diff --git")).toBe(true);
  });

  it("trims a large hunk to the requested lines", () => {
    const added = ["diff --git a/n.ts b/n.ts", "new file mode 100644", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1,6 @@", "+1", "+2", "+3", "+4", "+5", "+6", ""].join("\n");
    const result = filterPatchToRange(added, 3, 4);
    expect(result.filtered).toBe(true);
    expect(result.patch).toContain("@@ -0,0 +3,2 @@\n+3\n+4\n");
    expect(result.patch).not.toContain("+5");
  });

  it("keeps removed lines that sit inside the range", () => {
    const mixed = ["--- a/m.ts", "+++ b/m.ts", "@@ -10,4 +10,4 @@", " a", "-b", "+B", " c", " d", ""].join("\n");
    const result = filterPatchToRange(mixed, 11, 11);
    expect(result.patch).toContain("@@ -11,1 +11,1 @@\n-b\n+B\n");
  });

  it("returns the whole patch when nothing matches", () => {
    expect(filterPatchToRange(patch, 200, 210)).toEqual({ patch, filtered: false });
  });
});

describe("shortRef", () => {
  it("abbreviates full SHAs and passes branch names through", () => {
    expect(shortRef("c884aad1f2e3d4c5b6a79880112233445566aabb")).toBe("c884aad1");
    expect(shortRef("origin/main")).toBe("origin/main");
    expect(shortRef("c884aad")).toBe("c884aad");
  });

  it("names the empty tree", () => {
    expect(shortRef("4b825dc642cb6eb9a060e54bf8d69288fbee4904")).toBe("start of history");
    expect(comparedWith({ baseRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" })).toBe("everything since the start of history");
  });

  it("keeps only the leading token of an annotated ref", () => {
    expect(shortRef("c884aad (PR base on main)")).toBe("c884aad");
    expect(comparedWith({ baseRef: "c884aad (PR base on main)" })).toBe("compared with c884aad");
  });
});

describe("walkthrough list labels", () => {
  it("uses user words for each status", () => {
    expect(["planning", "reading", "wrapping-up", "done", "failed"].map((status) => statusLabel(status as never))).toEqual([
      "Getting ready",
      "In progress",
      "Wrapping up",
      "Finished",
      "Stopped",
    ]);
  });

  it("formats the start time relative to today", () => {
    const now = new Date(2026, 4, 20, 15, 0).getTime();
    expect(formatStarted(new Date(2026, 4, 19, 9, 0).getTime(), now)).toBe("Yesterday");
    expect(formatStarted(new Date(2026, 4, 20, 9, 5).getTime(), now)).toMatch(/9:05/u);
    expect(formatStarted(new Date(2026, 2, 5, 9, 0).getTime(), now)).toMatch(/Mar/u);
    expect(formatStarted(new Date(2025, 2, 5, 9, 0).getTime(), now)).toMatch(/2025/u);
  });

  it("shows status, progress, and start time", () => {
    const now = new Date(2026, 4, 20, 15, 0).getTime();
    const createdAt = new Date(2026, 4, 19, 9, 0).getTime();
    expect(summaryDetail({ status: "reading", partCount: 6, currentPart: 1, createdAt }, now)).toBe("In progress · Part 2 of 6 · Yesterday");
    expect(summaryDetail({ status: "reading", partCount: 6, currentPart: null, createdAt }, now)).toBe("In progress · Introduction · Yesterday");
    expect(summaryDetail({ status: "done", partCount: 6, currentPart: 5, createdAt }, now)).toBe("Finished · 6 parts · Yesterday");
    expect(summaryDetail({ status: "planning", partCount: 0, currentPart: null, createdAt }, now)).toBe("Getting ready · Yesterday");
  });
});

describe("excerpt views", () => {
  const context = ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", "@@ -1,2 +1,2 @@", " one", " two", ""].join("\n");
  const changed = ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", "@@ -1,2 +1,2 @@", " one", "-two", "+TWO", ""].join("\n");

  it("opens an excerpt of unchanged code as after, and a real change as change", () => {
    expect(defaultExcerptView({ change: context, after: "one\ntwo" })).toBe("after");
    expect(defaultExcerptView({ change: changed, after: "one\nTWO" })).toBe("change");
    expect(defaultExcerptView({ change: null, after: "x" })).toBe("after");
    expect(defaultExcerptView({ change: context, after: null })).toBe("change");
  });

  it("does not mistake file headers for changes", () => {
    expect(hasChangedLines(context)).toBe(false);
    expect(hasChangedLines(changed)).toBe(true);
  });

  it("copies the code of the shown view", () => {
    expect(excerptCode(changed, "after")).toBe("one\nTWO");
    expect(excerptCode(changed, "before")).toBe("one\ntwo");
    expect(excerptCode(changed, "change")).toBe(" one\n-two\n+TWO");
  });
});

describe("note anchors", () => {
  it("starts a typed note on the current part with no file or quote", () => {
    expect(blankTarget(2)).toEqual({ groupIndex: 2, location: null, quote: null });
    expect(blankTarget(null)).toEqual({ groupIndex: null, location: null, quote: null });
  });

  it("anchors a selection to what it implies and nothing else", () => {
    expect(targetFromDraft({ quote: "q", groupIndex: 1, sequence: 1 })).toEqual({ groupIndex: 1, location: null, quote: "q" });
    const location = { path: "src/a.ts", startLine: 3, endLine: 9 };
    expect(targetFromDraft({ quote: "q", groupIndex: 1, location, sequence: 2 })).toEqual({ groupIndex: 1, location, quote: "q" });
  });

  it("offers the part's code excerpts first, then its files, without duplicates", () => {
    const base = walkthrough();
    const withBlocks = walkthrough({
      parts: [
        {
          ...base.parts[0]!,
          locations: [{ path: "src/b.ts" }, { path: "src/a.ts", startLine: 3, endLine: 9 }],
          blocks: [{ kind: "prose", text: "x" }, { kind: "code", caption: "c", path: "src/a.ts", startLine: 3, endLine: 9, notes: [] }],
        },
      ],
    });
    expect(locationChoices(withBlocks, 0)).toEqual([{ path: "src/a.ts", startLine: 3, endLine: 9 }, { path: "src/b.ts" }]);
    expect(locationChoices(withBlocks, null)).toEqual([]);
    expect(locationChoices(withBlocks, null, { path: "z.ts" })).toEqual([{ path: "z.ts" }]);
  });

  it("applies typed lines to the chosen file", () => {
    const choice = { path: "src/a.ts", startLine: 3, endLine: 9 };
    expect(linesText(choice)).toBe("3-9");
    expect(linesText({ path: "src/a.ts" })).toBe("");
    expect(noteLocation(null, "4")).toBeNull();
    expect(noteLocation(choice, "")).toEqual({ path: "src/a.ts" });
    expect(noteLocation(choice, "12")).toEqual({ path: "src/a.ts", startLine: 12 });
    expect(noteLocation(choice, "40-12")).toEqual({ path: "src/a.ts", startLine: 12, endLine: 40 });
    expect(noteLocation(choice, "soon")).toEqual(choice);
  });

  it("places the note button by the pointer when the selection has no rect", () => {
    const empty = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    const rect = { top: 200, bottom: 220, left: 50, right: 150, width: 100, height: 20 };
    expect(noteButtonPosition(rect, { x: 90, y: 215 }, { top: 100, left: 10 })).toEqual({ top: 126, left: 40 });
    expect(noteButtonPosition(empty, { x: 90, y: 215 }, { top: 100, left: 10 })).toEqual({ top: 127, left: 80 });
  });
});
