import { describe, expect, it } from "vitest";
import { parseCommand, renderNotesMarkdown } from "../src/model.ts";
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
