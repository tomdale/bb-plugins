// A fake worker that follows a recorded timeline, run through the real service
// and stream tail on a virtual clock. It measures the protocol (what the worker
// says, when, and how often it repeats itself), not any model: the stage
// durations are taken from a recorded real worker thread (see the comment on
// REAL), so the table says how much of a real run the protocol change removes,
// not how long a real run takes. Set FIRST_PAINT_REPORT=<file> to write the table.
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAN, setup, THREAD } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

/**
 * Stage durations, seconds, read off a recorded real worker thread (a PR review
 * on a spawned worker): about 4.3 s from the request to the first model step,
 * about 26 s of reading code over seven tool steps, and generation at about 280
 * characters per second (a 2,811-character plan call took 9.5 s; a 2,105-character
 * write call 8.3 s).
 */
const REAL = { startup: 4.3, reading: 26, charsPerSecond: 280 };
// About 700 characters of introduction and 1,600 of part prose, like the recorded run's calls.
const INTRO = "Before this change, requests had no limit at all. ".repeat(14).trim();
const PROSE = "Each job waits in [the queue](line:3) until a slot frees up, and the cap bounds how many wait. ".repeat(17).trim();
const PART_ONE = [PROSE, "", "```walkthrough", "path: tts.ts", "lines: 1-10", "view: code", "caption: The cap, in tts.ts", "note 3: Truncates here.", "```", "", "```walkthrough", "suggestions:", "Why 4,000?", "What if it is exactly 4,000?", "```"].join("\n");
const MESSAGE = `${INTRO}\n\n\`\`\`walkthrough\npart: 1\n\`\`\`\n\n${PART_ONE.repeat(1)}`;
const gen = (chars: number) => chars / REAL.charsPerSecond;

type Provider = "whole-message" | "chunked";
type Protocol = "repeat" | "say-once";

async function run(protocol: Protocol, provider: Provider) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const rows: Array<{ seq: number; itemId: string; delta: string }> = [];
  let seq = 100;
  const patch = "--- a/tts.ts\n+++ b/tts.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const readCode = () => ({ path: "tts.ts", patch, truncated: false, sides: { old: { path: "tts.ts", content: "old\n" }, new: { path: "tts.ts", content: "new\n" } } });
  const { rpc, tool, view } = await setup({ deltas: () => rows, readCode });
  const startPromise = rpc("start", { threadId: THREAD, request: "Walk me through this" });
  await vi.advanceTimersByTimeAsync(100);
  const { walkthroughId } = await startPromise;
  const base = Date.now();
  const at = async (seconds: number) => vi.advanceTimersByTimeAsync(Math.max(0, base + seconds * 1000 - Date.now()));
  // Emits a message: whole at its end, or in chunks while it is generated.
  const say = async (id: string, text: string, from: number) => {
    const seconds = gen(text.length);
    if (provider === "whole-message") {
      await at(from + seconds);
      rows.push({ seq: (seq += 1), itemId: id, delta: text });
    } else {
      const steps = Math.max(1, Math.round(seconds * 10));
      const size = Math.ceil(text.length / steps);
      for (let step = 0; step < steps; step += 1) {
        await at(from + ((step + 1) * seconds) / steps);
        rows.push({ seq: (seq += 1), itemId: id, delta: text.slice(step * size, (step + 1) * size) });
      }
    }
    return from + seconds;
  };

  let clock = REAL.startup;
  const { introduction, ...planWithoutIntro } = PLAN;
  if (protocol === "say-once") {
    // An opening message before any reading.
    clock = await say("open", INTRO.slice(0, 160), clock);
    await at(clock + REAL.reading);
    clock += REAL.reading;
    clock = await say("full", MESSAGE, clock);
    const planChars = JSON.stringify(planWithoutIntro).length;
    await at(clock + gen(planChars));
    clock += gen(planChars);
    await tool("walkthrough_plan", planWithoutIntro);
    await at(clock + gen(40));
    clock += gen(40);
    await tool("walkthrough_write_part", { part: 1 });
  } else {
    await at(clock + REAL.reading);
    clock += REAL.reading;
    clock = await say("full", MESSAGE, clock);
    const planChars = JSON.stringify(PLAN).length;
    await at(clock + gen(planChars));
    clock += gen(planChars);
    await tool("walkthrough_plan", { ...planWithoutIntro, introduction: INTRO });
    const blocks = [{ kind: "prose", text: PROSE }, { kind: "code", caption: "The cap, in tts.ts", path: "tts.ts", startLine: 1, endLine: 10, view: "code", notes: [{ line: 3, text: "Truncates here." }] }];
    const writeChars = JSON.stringify({ part: 1, blocks, suggestions: ["Why 4,000?", "What if it is exactly 4,000?"] }).length;
    await at(clock + gen(writeChars));
    clock += gen(writeChars);
    await tool("walkthrough_write_part", { part: 1, blocks, suggestions: ["Why 4,000?", "What if it is exactly 4,000?"] });
  }
  await vi.advanceTimersByTimeAsync(300);
  const timing = (await view(walkthroughId)).walkthrough.timing as Record<string, number>;
  return { firstText: timing.firstText! / 1000, planned: timing.planned! / 1000, part1Ready: timing.part1Ready! / 1000 };
}

describe("first paint on a fake worker, real service and tail", () => {
  it("shows the first words within seconds and commits part 1 sooner when the worker says each thing once", async () => {
    const results: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const provider of ["whole-message", "chunked"] as const) {
      for (const protocol of ["repeat", "say-once"] as const) results[`${protocol} / ${provider}`] = await run(protocol, provider);
      vi.useRealTimers();
    }
    const rows = Object.entries(results).map(([name, value]) => `| ${name} | ${value.firstText.toFixed(1)} | ${value.planned.toFixed(1)} | ${value.part1Ready.toFixed(1)} |`);
    const table = ["| worker protocol / provider | first words (s) | plan committed (s) | part 1 committed (s) |", "| --- | --- | --- | --- |", ...rows].join("\n");
    if (process.env.FIRST_PAINT_REPORT) writeFileSync(process.env.FIRST_PAINT_REPORT, `${table}\n`);
    for (const provider of ["whole-message", "chunked"] as const) {
      const before = results[`repeat / ${provider}`]!;
      const after = results[`say-once / ${provider}`]!;
      expect(after.firstText).toBeLessThan(before.firstText);
      expect(after.firstText).toBeLessThan(REAL.startup + 2);
      expect(after.part1Ready).toBeLessThan(before.part1Ready - 4);
    }

  }, 60_000);
});
