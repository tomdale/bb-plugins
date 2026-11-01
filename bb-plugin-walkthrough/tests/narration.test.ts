import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { removeNarration, stripNarration, stripNarrationFromBlocks } from "../src/narration.ts";
import { repairNarration } from "../src/repair.ts";
import { committedMessage } from "../src/stream-commit.ts";
import { extractContent, parseStreamMarkup, START_MARKER } from "../src/stream-markup.ts";
import { StreamTail, type DeltaRow } from "../src/stream-tail.ts";
import { streamedView } from "../src/ui/stream.ts";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

const BODY = [
  "Retries now stop after [three attempts](line:42).",
  "",
  "```walkthrough",
  "path: src/upload.ts",
  "lines: 38-52",
  "view: diff",
  "caption: The retry loop, in upload.ts",
  "```",
  "",
  "Each retry waits longer than the last.",
  "",
  "```walkthrough",
  "suggestions:",
  "What happens on the fourth failure?",
  "```",
].join("\n");
const MESSAGE = ["Now let me set up the walkthrough plan.", "", START_MARKER, BODY, "", "Let me commit this.", "", "Done, part 3 committed."].join("\n");

describe("the start marker protocol", () => {
  it("takes the text after the marker line up to the suggestions fence, and nothing else", () => {
    expect(extractContent(MESSAGE)).toBe(BODY);
  });

  it("has no content without a marker line, or before the marker line is complete", () => {
    expect(extractContent(BODY)).toBe("");
    expect(extractContent(`Hello.\n${START_MARKER.slice(0, 12)}`)).toBe("");
    expect(extractContent(`Hello.\n${START_MARKER}`)).toBe("");
    expect(extractContent(`Hello.\n${START_MARKER}\nFirst words`)).toBe("First words");
  });

  it("accepts spacing variations, drops a repeated marker, and ignores a marker that is not alone on its line", () => {
    expect(extractContent("<!--walkthrough:start-->\nText.")).toBe("Text.");
    expect(extractContent(`${START_MARKER}\nA.\n${START_MARKER}\nB.`)).toBe("A.\nB.");
    expect(extractContent(`Note: ${START_MARKER}\nText.`)).toBe("");
  });

  it("withholds a half-typed marker so it never shows as prose", () => {
    expect(extractContent(`${START_MARKER}\nText.\n<!-- walk`)).toBe("Text.");
    expect(extractContent(`${START_MARKER}\nText.\n<!-- walkthrough:start --`)).toBe("Text.");
    expect(extractContent(`${START_MARKER}\nText.\n<!-- an ordinary comment`)).toBe("Text.\n<!-- an ordinary comment");
  });

  it("keeps the opening sentence out of the plan turn's content", () => {
    const text = `I'll walk through the retries.\n\nI read the code.\n${START_MARKER}\nIntro.\n\n\`\`\`walkthrough\npart: 1\n\`\`\`\n\n${BODY}`;
    expect(extractContent(text).startsWith("Intro.")).toBe(true);
    expect(committedMessage(extractContent(text)).introduction).toBe("Intro.");
  });

  it("is total and monotonic: the content of every prefix is a prefix of the content of the whole", () => {
    const whole = `Chatter.\n${START_MARKER}\n${BODY}\n\nDone.`;
    const wholeContent = extractContent(whole);
    for (let end = 0; end <= whole.length; end += 1) {
      const content = extractContent(whole.slice(0, end));
      expect(wholeContent.startsWith(content)).toBe(true);
    }
    const pieces = ["<!--", " walkthrough:start ", "-->", "\n", "```walkthrough\n", "suggestions:\n", "q\n", "```", "text ", "\r", "\u0000"];
    let seed = 3;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let run = 0; run < 200; run += 1) {
      let text = "";
      for (let n = 0; n < 30; n += 1) text += pieces[Math.floor(random() * pieces.length)];
      const full = extractContent(text);
      for (let end = 0; end <= text.length; end += 1) expect(full.startsWith(extractContent(text.slice(0, end)))).toBe(true);
    }
    for (const bad of [undefined, null, 5, {}] as unknown[]) expect(extractContent(bad as string)).toBe("");
  });

  it("stops parsing at the suggestions fence, so later text never becomes a block", () => {
    const parsed = parseStreamMarkup(`${BODY}\n\nNow let me set up the plan.\n`);
    expect(parsed.complete).toBe(true);
    expect(parsed.blocks.map((block) => block.kind)).toEqual(["prose", "figure", "prose", "suggestions"]);
    expect(parsed.endLine).toBe(BODY.split("\n").length);
  });

  it("is in every worker instruction that carries the markup, within the delivery limit", async () => {
    const { PLAN_INSTRUCTIONS, WRITE_PART_INSTRUCTIONS } = await import("../src/worker.ts");
    for (const text of [PLAN_INSTRUCTIONS, WRITE_PART_INSTRUCTIONS]) {
      expect(text).toContain(START_MARKER);
      expect(text.length).toBeLessThan(4096);
    }
  });
});

describe("the tail and the pane agree with the commit", () => {
  const rows = (parts: Array<[string, string]>): DeltaRow[] => parts.map(([itemId, delta], index) => ({ seq: 101 + index, itemId, delta }));
  const target = { walkthroughId: "wt_1", workerThreadId: "thr_w", request: { kind: "write", part: 3 } as const, afterSeq: 100, sentAt: 1 };

  it("publishes only content, never the chatter around it, at every prefix of the message", async () => {
    for (let end = 0; end <= MESSAGE.length; end += 25) {
      const tail = new StreamTail({ readDeltas: async (_thread, after) => rows([["a", MESSAGE.slice(0, end)]]).filter((row) => row.seq > after), publish: () => undefined });
      const snapshot = await tail.snapshot(target);
      expect(snapshot!.text).not.toMatch(/Now let me|Let me commit|Done, part/u);
      expect(BODY.startsWith(snapshot!.text)).toBe(true);
    }
  });

  it("previews exactly the blocks the commit saves, even when the helper's content carries narration", async () => {
    const dirty = `${START_MARKER}\nLet me read the code first.\n\n${BODY.replace("```walkthrough\nsuggestions:", "Done, part 3 committed.\n\n```walkthrough\nsuggestions:")}`;
    const tail = new StreamTail({ readDeltas: async (_thread, after) => rows([["a", dirty]]).filter((row) => row.seq > after), publish: () => undefined });
    const snapshot = (await tail.snapshot(target))!;
    const preview = streamedView(snapshot).blocks.map((block) => (block.kind === "prose" ? block.text : block.kind));
    const saved = committedMessage(snapshot.text).blocks.map((block) => (block.kind === "prose" ? block.text : block.kind));
    expect(preview).toEqual(saved);
    expect(saved).toEqual(["Retries now stop after [three attempts](line:42).", "code", "Each retry waits longer than the last."]);
  });

  it("uses the last message that holds the marker, whatever the helper says in later messages", async () => {
    const tail = new StreamTail({
      readDeltas: async (_thread, after) => rows([["open", "I'll walk through the retries."], ["read", "Let me read the code."], ["full", `${START_MARKER}\n${BODY}\n\nNow let me set up the walkthrough plan.`], ["after", "Part 3 is on the page."]]).filter((row) => row.seq > after),
      publish: () => undefined,
    });
    expect((await tail.snapshot(target))!.text).toBe(BODY);
  });
});

describe("the narration backstop", () => {
  it("removes meta paragraphs before and after the content", () => {
    expect(stripNarration("Now let me set up the walkthrough plan.\n\nThe cap is 4,000.")).toBe("The cap is 4,000.");
    expect(stripNarration("Let me read the code first.\n\nNow let me trace it.\n\nThe cap is 4,000.")).toBe("The cap is 4,000.");
    expect(stripNarration("I'll walk through the retries.\n\nThe cap is 4,000.")).toBe("The cap is 4,000.");
    expect(stripNarration("The cap is 4,000.\n\nDone, part 3 committed.")).toBe("The cap is 4,000.");
    expect(stripNarration("The cap is 4,000.\n\nI've written part 2.")).toBe("The cap is 4,000.");
    expect(stripNarration("The cap is 4,000.\n\nPart 1 is in the pane — next is retries.")).toBe("The cap is 4,000.");
    expect(stripNarration("The cap is 4,000.\n\nNow let me set up the walkthrough plan.")).toBe("The cap is 4,000.");
    expect(removeNarration("Let me look.\n\nBody.\n\nDone.").removed).toEqual(["Let me look.", "Done."]);
  });

  it("keeps legitimate prose that starts with similar words", () => {
    const keep = [
      "First, the key is read from the header.",
      "First, I'd note that the cap is shared by every caller, so it lives here.",
      "Now the sending side. Part 1 prepared the account.",
      "Now it is a loop that wraps the same work.",
      "Let's look at what the cache does on a miss.",
      "Letting the queue drain first avoids a race.",
      "Done reading the header, the loop exits.",
      "Committed offsets are only saved after the batch.",
      "The walkthrough traces the two schemas first, then follows the read path.",
      "Part 2 is where the retry policy lives.",
      "I've seen this pattern fail when the clock moves back, so the code compares monotonic time.",
    ];
    for (const text of keep) expect(stripNarration(text)).toBe(text);
    // Only edge paragraphs go: the same words in the middle stay.
    const middle = "The cap is 4,000.\n\nLet me be precise: it counts bytes.\n\nDone, the loop exits when it is empty. The rest follows.";
    expect(stripNarration(middle)).toBe(middle);
    // A long paragraph that begins like narration is explanation.
    const long = `Let me explain why the cap exists. ${"It bounds memory use for every caller. ".repeat(12)}`;
    expect(stripNarration(long)).toBe(long);
  });

  it("is idempotent and total on odd input", () => {
    for (const text of ["", "\n\n", "Let me.", "Let me.\n\nLet me.", "Done.\n\nDone.", "\r\nLet me look.\r\n\r\nBody."]) {
      const once = stripNarration(text);
      expect(stripNarration(once)).toBe(once);
    }
  });

  it("applies to the first and last prose blocks of a part only, and drops blocks it empties", () => {
    const code = { kind: "code", caption: "c", path: "a.ts", startLine: 1, endLine: 2, notes: [] };
    const blocks = [{ kind: "prose", text: "Let me read it." }, { kind: "prose", text: "The cap is 4,000." }, code, { kind: "prose", text: "Done, part 3 committed." }];
    expect(stripNarrationFromBlocks(blocks)).toEqual([blocks[1], code]);
    const inner = [{ kind: "prose", text: "Body." }, code, { kind: "prose", text: "Let me explain the middle." }, code, { kind: "prose", text: "End." }];
    expect(stripNarrationFromBlocks(inner)).toEqual(inner);
  });

  it("is applied when a view is delivered", async () => {
    const { rpc, tool, view } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "x" });
    await settle();
    await tool("walkthrough_plan", { ...PLAN, introduction: "I'll walk through this.\n\nThe real introduction." });
    await tool("walkthrough_write_part", { part: 1, blocks: [{ kind: "prose", text: "The part." }, { kind: "prose", text: "Now let me set up the walkthrough plan." }], suggestions: ["Q?"] });
    const delivered = (await view(walkthroughId)).walkthrough;
    expect(delivered.introduction).toBe("The real introduction.");
    expect(delivered.parts[0].blocks).toEqual([{ kind: "prose", text: "The part." }]);
  });
});

describe("repairing stored walkthroughs", () => {
  const part = (...texts: string[]) => ({ status: "ready", blocks: texts.map((text) => ({ kind: "prose", text })) });
  const stored = {
    id: "wt_x",
    introduction: "I'll walk through the retries.\n\nBefore this change nothing retried.",
    parts: [part("The loop.", "Now let me set up the walkthrough plan."), part("Clean part.")],
    extra: { kept: true },
  };

  it("lists each removed paragraph with where it was, carries every other field through, and leaves clean parts as they were", () => {
    const { walkthrough, changes } = repairNarration(stored);
    expect(changes).toEqual([
      { where: "introduction", removed: "I'll walk through the retries." },
      { where: "part 1", removed: "Now let me set up the walkthrough plan." },
    ]);
    expect(walkthrough.introduction).toBe("Before this change nothing retried.");
    expect(walkthrough.parts[0]!.blocks).toEqual([{ kind: "prose", text: "The loop." }]);
    expect(walkthrough.parts[1]).toBe(stored.parts[1]);
    expect(walkthrough.extra).toEqual({ kept: true });
  });

  it("is idempotent: the repaired record has nothing left to repair and is returned as is", () => {
    const once = repairNarration(stored).walkthrough;
    const again = repairNarration(once);
    expect(again.changes).toEqual([]);
    expect(again.walkthrough).toBe(once);
  });
});

describe("a fake worker whose messages have chatter before, between and after the content", () => {
  it("saves only the content, in both the plan turn and a part write", async () => {
    const rows: Array<{ seq: number; itemId: string; delta: string }> = [];
    let seq = 100;
    const say = (itemId: string, delta: string) => rows.push({ seq: (seq += 1), itemId, delta });
    const patch = "--- a/src/upload.ts\n+++ b/src/upload.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const readCode = () => ({ path: "src/upload.ts", patch, truncated: false, sides: { old: { path: "src/upload.ts", content: "old\n" }, new: { path: "src/upload.ts", content: "new\n" } } });
    const { rpc, tool, view } = await setup({ deltas: () => rows, readCode });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "Walk me through this" });
    await settle();
    // Before: the opening sentence and a reading announcement, each its own message.
    say("open", "I'll walk through the retry change.");
    say("read", "Let me read the code first.");
    // The content message, with chatter on both sides of it and a stray line before the marker.
    say("plan", `Now let me write the introduction.\n${START_MARKER}\nBefore this change nothing retried.\n\n\`\`\`walkthrough\npart: 1\n\`\`\`\n\n${BODY}\n\nNow let me set up the walkthrough plan.`);
    // After: a confirmation in its own message.
    say("after", "Part 1 committed.");
    const { introduction: _omitted, ...withoutIntroduction } = PLAN;
    await tool("walkthrough_plan", withoutIntroduction);
    expect(await tool("walkthrough_write_part", { part: 1 })).toBe("Part 1 is on the page.");
    const current = (await view(walkthroughId)).walkthrough;
    expect(current.introduction).toBe("Before this change nothing retried.");
    expect(current.parts[0].blocks.map((block: { kind: string; text?: string }) => (block.kind === "prose" ? block.text : block.kind))).toEqual(["Retries now stop after [three attempts](line:42).", "code", "Each retry waits longer than the last."]);
    expect(JSON.stringify(current)).not.toMatch(/Now let me|Let me read|I'll walk|Part 1 committed/u);
  }, 20_000);
});

describe("scripts/repair-narration.ts", () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "scripts/repair-narration.ts", ...args], { encoding: "utf8" });

  it("is a dry run by default, backs up before writing, touches only affected rows, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-"));
    const path = join(dir, "data.db");
    try {
      const database = new DatabaseSync(path);
      database.exec("CREATE TABLE walkthroughs_v2 (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, worker_thread_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)");
      const insert = database.prepare("INSERT INTO walkthroughs_v2 VALUES (?, 't', NULL, 'ready', ?, 1)");
      const dirty = { title: "Dirty", introduction: "Intro.", parts: [{ blocks: [{ kind: "prose", text: "Body." }, { kind: "prose", text: "Now let me set up the walkthrough plan." }] }] };
      const clean = JSON.stringify({ title: "Clean", introduction: "Intro.", parts: [{ blocks: [{ kind: "prose", text: "Body." }] }] });
      insert.run("wt_dirty", JSON.stringify(dirty));
      insert.run("wt_clean", clean);
      database.close();

      const dry = run(path);
      expect(dry).toContain("=== wt_dirty  Dirty");
      expect(dry).toContain("- Now let me set up the walkthrough plan.");
      expect(dry).toContain("1 of 2 walkthroughs");
      expect(readdirSync(dir)).toEqual(["data.db"]);
      expect(rows(path).wt_dirty).toContain("Now let me");

      expect(run(path, "--write")).toContain("Updated 1 walkthroughs.");
      const backups = readdirSync(dir).filter((name) => name.startsWith("data.db.bak-"));
      expect(backups).toHaveLength(1);
      expect(rows(join(dir, backups[0]!)).wt_dirty).toContain("Now let me");
      expect(rows(path).wt_dirty).not.toContain("Now let me");
      expect(rows(path).wt_clean).toBe(clean);

      expect(run(path, "--write")).toContain("0 of 2 walkthroughs");
      expect(readdirSync(dir).filter((name) => name.startsWith("data.db.bak-"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function rows(path: string): Record<string, string> {
    const database = new DatabaseSync(path);
    const found = Object.fromEntries((database.prepare("SELECT id, data FROM walkthroughs_v2").all() as unknown as Array<{ id: string; data: string }>).map((row) => [row.id, row.data]));
    database.close();
    return found;
  }
});
