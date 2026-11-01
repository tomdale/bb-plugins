// The offline eval layer: every deterministic check of the parts that decide
// whether a walkthrough works, run through the real service with the fake SDK
// and the committed fixtures, and reported as a table plus JSON.
//
//   npm run eval            (add --fail-fast to stop at the first failure)
//
// Exits 1 when a check fails, so a CI job gates on the same run a person does
// locally. No model, no credentials, no BB server: this layer can run anywhere
// node can.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatChecks } from "./checks/format.ts";
import { gateChecks } from "./checks/gate.ts";
import { helperModelChecks } from "./checks/helper-model.ts";
import { instructionChecks } from "./checks/instructions.ts";
import { streamedMessageChecks } from "./checks/streamed-message.ts";
import type { Check } from "./checks/check.ts";

const REPORT_DIR = fileURLToPath(new URL("./report/", import.meta.url));

interface Outcome {
  name: string;
  status: "pass" | "fail";
  ms: number;
  note: string;
  error: string | null;
}

function firstLine(cause: unknown): string {
  const text = cause instanceof Error ? (cause.message ?? "") : String(cause);
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

const checks: Check[] = [...streamedMessageChecks, ...helperModelChecks, ...instructionChecks, ...formatChecks, ...gateChecks];
const failFast = process.argv.includes("--fail-fast");

const outcomes: Outcome[] = [];
const startedAt = new Date();
for (const check of checks) {
  const began = performance.now();
  try {
    const note = await check.run();
    outcomes.push({ name: check.name, status: "pass", ms: Math.round(performance.now() - began), note: note ?? "", error: null });
  } catch (cause) {
    outcomes.push({ name: check.name, status: "fail", ms: Math.round(performance.now() - began), note: "", error: firstLine(cause) });
    if (failFast) break;
  }
}

const width = Math.max(...outcomes.map((outcome) => outcome.name.length));
const ms = (value: number) => `${value} ms`.padStart(7);
console.log(`\nWalkthrough helper eval (offline) — ${outcomes.length} checks`);
for (const outcome of outcomes) {
  const mark = outcome.status === "pass" ? "✓" : "✗";
  const note = outcome.status === "pass" ? outcome.note : outcome.error;
  console.log(`  ${mark} ${outcome.name.padEnd(width)} ${ms(outcome.ms)}  ${note ?? ""}`);
}
const failed = outcomes.filter((outcome) => outcome.status === "fail");
console.log(`\n${outcomes.length - failed.length} passed, ${failed.length} failed${failFast && failed.length > 0 && outcomes.length < checks.length ? ` (stopped early, ${checks.length - outcomes.length} not run)` : ""}`);

mkdirSync(REPORT_DIR, { recursive: true });
const report = `${REPORT_DIR}offline.json`;
writeFileSync(
  report,
  `${JSON.stringify({ startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), failed: failed.length, checks: outcomes }, null, 2)}\n`,
);
console.log(`report: ${report}\n`);

process.exitCode = failed.length === 0 ? 0 : 1;
