import { describe, expect, it } from "vitest";
import {
  advance,
  applyPauseResponse,
  enterFinishing,
  parseCommand,
  renderNotesMarkdown,
  reviseOutline,
} from "../src/model.ts";
import { filterPatchToRange } from "../src/patch.ts";
import type { Note, Walkthrough } from "../src/schemas.ts";

function walkthrough(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    id: "wt_1",
    threadId: "thr_1",
    mode: "local",
    status: "overview",
    title: "Branch feature",
    baseRef: "origin/main",
    headRef: null,
    includeUncommitted: true,
    pr: null,
    groups: ["Schema", "Store", "UI"].map((title) => ({ title, summary: "", locations: [], status: "pending" as const })),
    currentGroup: null,
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/w",
    notesFile: { enabled: true, path: "/w/.agent/review-notes.md", written: false, error: null },
    review: null,
    pause: null,
    nextNoteNumber: 1,
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
  it("recognizes canonical dotted commands", () => {
    expect(parseCommand(".next")).toEqual({ kind: "navigate", action: "next" });
    expect(parseCommand("  .finish ")).toEqual({ kind: "navigate", action: "finish" });
    expect(parseCommand(".notes")).toEqual({ kind: "notes" });
    expect(parseCommand(".todo rename the cache")).toEqual({ kind: "record", noteKind: "todo", text: "rename the cache" });
    expect(parseCommand(".question")).toEqual({ kind: "incomplete", noteKind: "question" });
  });

  it("treats everything else as a question for the agent", () => {
    expect(parseCommand("why .next?")).toEqual({ kind: "text", text: "why .next?" });
    expect(parseCommand(".next please")).toEqual({ kind: "text", text: ".next please" });
    expect(parseCommand(".unknown thing")).toEqual({ kind: "text", text: ".unknown thing" });
  });
});

describe("transitions", () => {
  it("walks groups in order and finishes after the last", () => {
    let state = advance(walkthrough(), 1);
    expect(state.status).toBe("reviewing");
    expect(state.currentGroup).toBe(0);
    state = advance(advance(state, 2), 3);
    expect(state.currentGroup).toBe(2);
    expect(state.groups.map((group) => group.status)).toEqual(["done", "done", "current"]);
    state = advance(state, 4);
    expect(state.status).toBe("finishing");
    expect(state.groups.every((group) => group.status === "done")).toBe(true);
  });

  it("marks unpresented groups skipped on an early finish", () => {
    const state = enterFinishing(advance(walkthrough(), 1), 2);
    expect(state.groups.map((group) => group.status)).toEqual(["done", "skipped", "skipped"]);
    expect(state.currentGroup).toBeNull();
  });

  it("keeps state on ask and closes on complete", () => {
    const start = advance(walkthrough(), 1);
    expect(applyPauseResponse(start, { action: "ask", text: "hm" }, 2)).toBe(start);
    expect(applyPauseResponse(start, { action: "complete" }, 2).status).toBe("finished");
  });

  it("revises only unpresented groups", () => {
    const state = reviseOutline(advance(walkthrough(), 1), [{ title: "New", summary: "", locations: [] }], 2);
    expect(state.groups.map((group) => [group.title, group.status])).toEqual([
      ["Schema", "current"],
      ["New", "pending"],
    ]);
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
    expect(markdown).toContain("## Questions\n\n- [Group 1: Schema · src/a.ts:3-9] Why? (n1)");
    expect(markdown).toContain("## Todos\n\n- Rename (n2)");
    expect(markdown).not.toContain("## Comments");
    expect(markdown).toContain("## Resolved / Answered\n\n- [Question · Group 1: Schema] Why? (n3)\n  Answer: Because.");
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
    "@@ -40,2 +41,3 @@",
    " x",
    "+y",
    "",
  ].join("\n");

  it("keeps only hunks intersecting the range", () => {
    const result = filterPatchToRange(patch, 41, 42);
    expect(result.filtered).toBe(true);
    expect(result.patch).toContain("@@ -40,2 +41,3 @@");
    expect(result.patch).not.toContain("@@ -1,3 +1,4 @@");
    expect(result.patch.startsWith("diff --git")).toBe(true);
  });

  it("returns the whole patch when nothing matches", () => {
    expect(filterPatchToRange(patch, 200, 210)).toEqual({ patch, filtered: false });
  });
});
