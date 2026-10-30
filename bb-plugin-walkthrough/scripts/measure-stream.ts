// Replays a recorded sequence of worker message deltas through the real
// StreamTail and parser, in real time, and reports how quickly the text
// reaches a client: time to first block, delay from each delta to the publish
// that carries it, and the publish cadence.
//
//   node --experimental-transform-types --no-warnings scripts/measure-stream.ts --synthetic [--chunk-ms 25] [--read-latency 15]
//   node --experimental-transform-types --no-warnings scripts/measure-stream.ts recording.jsonl [--read-latency 15]
//   node --experimental-transform-types --no-warnings scripts/measure-stream.ts --from-thread thr_abc123   (reads a real thread with the bb CLI)
//
// A recording is JSON lines {"t": <ms since the first delta>, "itemId": "...", "delta": "..."}.
// --read-latency simulates the SDK round trip of one events.list call.
// --from-thread keeps only the deltas' timing and text; use it on a thread you
// own, since the text is printed only as lengths.
//
// This measures the tail, not a model: with a recording from a real worker
// the numbers show the tail's added delay on top of when BB stored the event.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseStreamMarkup } from "../src/stream-markup.ts";
import { StreamTail, type DeltaRow } from "../src/stream-tail.ts";

interface Recorded {
  t: number;
  itemId: string;
  delta: string;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(args[at + 1]);
};
const readLatency = flag("read-latency", 0);

function synthetic(chunkMs: number): Recorded[] {
  const text = [
    "Before this change the key was read once, and [the cap](line:42) bounds it now.",
    "",
    "```walkthrough",
    "path: src/server.ts",
    "lines: 40-52",
    "view: diff",
    "caption: Looking up the key, in server.ts",
    "note 42: Truncates here.",
    "```",
    "",
    "Then the fallback applies.",
    "",
    "```walkthrough",
    "suggestions:",
    "What if the cap truncates mid-word?",
    "Who calls the helper?",
    "```",
    "",
  ].join("\n");
  const rows: Recorded[] = [];
  const words = text.match(/\S+\s*|\s+/gu) ?? [];
  words.forEach((word, index) => rows.push({ t: index * chunkMs, itemId: "item-1", delta: word }));
  return rows;
}

function fromThread(threadId: string): Recorded[] {
  const raw = execFileSync("bb", ["thread", "log", threadId, "--json", "--all"], { maxBuffer: 1 << 28, encoding: "utf8" });
  const events = JSON.parse(raw) as Array<{ seq: number; type: string; createdAt: number; data: { itemId?: string; delta?: string } }>;
  const deltas = events.filter((event) => event.type === "item/agentMessage/delta");
  const origin = deltas[0]?.createdAt ?? 0;
  return deltas.map((event) => ({ t: event.createdAt - origin, itemId: event.data.itemId ?? "item", delta: event.data.delta ?? "" }));
}

function load(): Recorded[] {
  if (args.includes("--synthetic")) return synthetic(flag("chunk-ms", 25));
  const thread = args.indexOf("--from-thread");
  if (thread >= 0) return fromThread(args[thread + 1]!);
  const file = args.find((arg) => !arg.startsWith("--") && arg !== String(readLatency));
  if (!file) throw new Error("give a recording file, --synthetic, or --from-thread <id>");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Recorded);
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const fmt = (ms: number): string => (Number.isNaN(ms) ? "n/a" : `${ms.toFixed(0)} ms`);

const recording = load();
if (recording.length === 0) throw new Error("the recording has no deltas");
const rows: DeltaRow[] = [];
const emitAt: number[] = [];
const publishes: Array<{ at: number; seq: number; blocks: number }> = [];
let started = 0;

const tail = new StreamTail({
  readDeltas: async (_thread, afterSeq) => {
    if (readLatency > 0) await new Promise((resolve) => setTimeout(resolve, readLatency));
    return rows.filter((row) => row.seq > afterSeq).slice(0, 100);
  },
  publish: (payload) => publishes.push({ at: performance.now() - started, seq: payload.seq, blocks: parseStreamMarkup(payload.text).blocks.length }),
});

started = performance.now();
tail.track({ walkthroughId: "measure", workerThreadId: "w", request: { kind: "write", part: 0 }, afterSeq: 0, sentAt: 1 });
// Delays are relative to the first delta, which is emitted a moment after tracking began.
const lead = 50;
for (const [index, row] of recording.entries()) {
  setTimeout(() => {
    rows.push({ seq: index + 1, itemId: row.itemId, delta: row.delta });
    emitAt[index] = performance.now() - started;
  }, lead + row.t);
}
const last = recording.at(-1)!.t;
await new Promise((resolve) => setTimeout(resolve, lead + last + 800));
await tail.finish("measure", "done");
tail.dispose();

const lags: number[] = [];
for (const [index, at] of emitAt.entries()) {
  const carrying = publishes.find((publish) => publish.at >= at && publish.seq >= index + 1);
  if (carrying) lags.push(carrying.at - at);
}
const firstBlock = publishes.find((publish) => publish.blocks > 0);
const gaps = publishes.slice(1).map((publish, index) => publish.at - publishes[index]!.at);
const lagOfFirstBlock = firstBlock ? firstBlock.at - emitAt[0]! : Number.NaN;

console.log(`deltas: ${recording.length} over ${fmt(last)} (${(recording.reduce((n, row) => n + row.delta.length, 0))} chars), read latency ${readLatency} ms`);
console.log(`publishes: ${publishes.length}`);
console.log(`time to first block (from first delta): ${fmt(lagOfFirstBlock)}`);
console.log(`delta to publish delay: median ${fmt(percentile(lags, 50))}, p95 ${fmt(percentile(lags, 95))}, max ${fmt(Math.max(...lags))}`);
console.log(`publish gap: median ${fmt(percentile(gaps, 50))}, p95 ${fmt(percentile(gaps, 95))}, min ${fmt(Math.min(...gaps))}`);
