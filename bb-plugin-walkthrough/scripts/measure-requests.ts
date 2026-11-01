// What the plugin's requests to the hidden worker actually cost: how long each kind of
// request took, which model ran it, what it billed in tokens, and how often it ended
// without giving the reader anything. Reads the per-request record the service keeps on
// each walkthrough (src/service.ts, "measuring itself"), so it needs no model, no
// network and no BB server.
//
//   node --experimental-transform-types --no-warnings scripts/measure-requests.ts
//   node --experimental-transform-types --no-warnings scripts/measure-requests.ts --db /tmp/copy.db
//   node --experimental-transform-types --no-warnings scripts/measure-requests.ts --walkthrough wt_abc123
//   node --experimental-transform-types --no-warnings scripts/measure-requests.ts --json
//
// The default database is the daily app's, opened read-only. Copy it first if you want to
// be certain nothing can be written: `cp ~/.bb/plugins/walkthrough/data.db* /tmp/`.
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { readWalkthrough } from "../src/store.ts";
import type { RequestRun, Walkthrough } from "../src/schemas.ts";

const FAILED = new Set(["empty", "failed", "interrupted", "abandoned", "nudged"]);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

const path = arg("db") ?? `${homedir()}/.bb/plugins/walkthrough/data.db`;
const only = arg("walkthrough");
const asJson = process.argv.includes("--json");

function walkthroughs(): { read: Walkthrough[]; skipped: number } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT data FROM walkthroughs_v2`).all() as Array<{ data: string }>;
    const read: Walkthrough[] = [];
    let skipped = 0;
    for (const row of rows) {
      try {
        read.push(readWalkthrough(JSON.parse(row.data)));
      } catch {
        skipped += 1;
      }
    }
    return { read, skipped };
  } finally {
    db.close();
  }
}

/** The value at `q` through the sorted sample, the midpoint for small n. */
function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

const seconds = (ms: number | null) => (ms === null ? "–" : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const count = (value: number | null) => (value === null ? "–" : value.toLocaleString("en-US"));
const pct = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((100 * part) / whole)}%`);

/** Right-pads every column of a block of rows to its widest cell. */
function table(head: string[], rows: string[][]): string {
  const widths = head.map((_, column) => Math.max(head[column]!.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

/** Grouped summary of the same fields, over whatever rows are given. */
function summary(title: string, rows: RequestRun[]): string[] {
  if (rows.length === 0) return [`## ${title}`, "", "No requests.", ""];
  const settled = rows.filter((run) => run.ms !== null);
  const lines = [`## ${title}`, ""];
  const kinds = [...new Set(rows.map((run) => run.kind))].sort();
  const body = kinds.map((kind) => {
    const of = rows.filter((run) => run.kind === kind);
    const durations = of.flatMap((run) => (run.ms === null ? [] : [run.ms]));
    const input = of.flatMap((run) => (run.inputTokens === null ? [] : [run.inputTokens + (run.cachedInputTokens ?? 0)]));
    const output = of.flatMap((run) => (run.outputTokens === null ? [] : [run.outputTokens]));
    const failures = of.filter((run) => run.outcome !== null && FAILED.has(run.outcome)).length;
    return [
      kind,
      String(of.length),
      seconds(percentile(durations, 0.5)),
      seconds(percentile(durations, 0.9)),
      seconds(durations.length === 0 ? null : durations.reduce((total, value) => total + value, 0) / durations.length),
      count(percentile(input, 0.5)),
      count(percentile(output, 0.5)),
      of.filter((run) => run.settledAt === null).length === 0 ? pct(failures, of.length) : `${pct(failures, of.length)} (${of.filter((run) => run.settledAt === null).length} open)`,
    ];
  });
  lines.push(table(["kind", "n", "p50", "p90", "mean", "tokens in", "tokens out", "not delivered"], body), "");
  const unanswered = settled.filter((run) => run.model === null).length;
  lines.push(`${rows.length} requests, ${settled.length} with a duration, ${rows.length - settled.length} never settled, ${unanswered} with no model recorded.`, "");
  return lines;
}

const { read, skipped } = walkthroughs();
const withRuns = read.filter((walkthrough) => (walkthrough.requests ?? []).length > 0);
const chosen = only === undefined ? withRuns : withRuns.filter((walkthrough) => walkthrough.id === only);
const runs = chosen.flatMap((walkthrough) => walkthrough.requests ?? []);

if (only !== undefined && chosen.length === 0) {
  console.error(`No recorded requests for ${only} in ${path}.`);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(chosen.map((walkthrough) => ({ id: walkthrough.id, createdAt: walkthrough.createdAt, requests: walkthrough.requests })), null, 2));
  process.exit(0);
}

const out: string[] = [];
out.push("# Walkthrough request record", "");
out.push(
  `${path} (read-only): ${read.length} walkthroughs${skipped === 0 ? "" : `, ${skipped} unreadable`}, ${withRuns.length} with a request record, ${runs.length} requests.`,
  "",
);
out.push(...summary("By kind", runs));

const models = new Map<string, Map<string, RequestRun[]>>();
for (const run of runs) {
  const model = run.model ?? "(not recorded)";
  const level = run.reasoning ?? "?";
  const levels = models.get(model) ?? new Map<string, RequestRun[]>();
  levels.set(level, [...(levels.get(level) ?? []), run]);
  models.set(model, levels);
}
if (runs.length > 0) {
  const cells = [...models.entries()].flatMap(([model, levels]) => [...levels.entries()].map(([level, group]) => ({ model, level, group })));
  out.push("## What ran", "");
  out.push(
    table(
      ["model", "level", "n", "p50", "tokens in", "tokens out"],
      cells
        .sort((a, b) => b.group.length - a.group.length)
        .map(({ model, level, group }) => [
          model,
          level,
          String(group.length),
          seconds(percentile(group.flatMap((run) => (run.ms === null ? [] : [run.ms])), 0.5)),
          count(percentile(group.flatMap((run) => (run.inputTokens === null ? [] : [run.inputTokens + (run.cachedInputTokens ?? 0)])), 0.5)),
          count(percentile(group.flatMap((run) => (run.outputTokens === null ? [] : [run.outputTokens])), 0.5)),
        ]),
    ),
    "",
  );

  // The point of recording the two separately: how often the server ran something other
  // than the model the plugin asked for.
  const asked = runs.filter((run) => run.askedModel !== null && run.model !== null && run.askedModel !== run.model);
  if (asked.length > 0) {
    out.push("## Asked for and run", "");
    out.push(
      table(
        ["asked", "ran", "n"],
        [...new Set(asked.map((run) => `${run.askedModel} -> ${run.model}`))].map((pair) => {
          const [from, to] = pair.split(" -> ");
          return [from!, to!, String(asked.filter((run) => run.askedModel === from && run.model === to).length)];
        }),
      ),
      "",
    );
  }

  out.push("## How they ended", "");
  out.push(
    table(
      ["outcome", "n"],
      [...new Set(runs.map((run) => run.outcome ?? "unsettled"))].sort().map((outcome) => [outcome, String(runs.filter((run) => (run.outcome ?? "unsettled") === outcome).length)]),
    ),
    "",
  );

  const failures = runs.filter((run) => run.outcome !== null && FAILED.has(run.outcome) && run.detail !== null);
  if (failures.length > 0) {
    out.push("## Reasons", "");
    const reasons = new Map<string, number>();
    for (const run of failures) reasons.set(`${run.kind}: ${run.detail}`, (reasons.get(`${run.kind}: ${run.detail}`) ?? 0) + 1);
    out.push(
      table(
        ["reason", "n"],
        [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => [reason, String(n)]),
      ),
      "",
    );
  }
}

if (only !== undefined) {
  out.push(`## ${only}`, "");
  out.push(
    table(
      ["#", "kind", "part", "outcome", "duration", "model", "tokens in", "tokens out", "detail"],
      runs.map((run) => [
        String(run.n),
        run.kind,
        run.part === null ? "" : String(run.part + 1),
        run.outcome ?? "unsettled",
        seconds(run.ms),
        run.model ?? run.askedModel ?? "–",
        count(run.inputTokens === null ? null : run.inputTokens + (run.cachedInputTokens ?? 0)),
        count(run.outputTokens),
        run.detail ?? "",
      ]),
    ),
    "",
  );
}

console.log(out.join("\n"));
