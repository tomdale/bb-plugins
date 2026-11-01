// The live eval layer: the measurement that decided HELPER_MODELS, end to end
// against the running BB app. Each run spawns a hidden scratch thread in a
// fixture repo, asks it for a walkthrough of its uncommitted changes, waits for
// that thread's own agent to open one, and then reads what the plugin's helper
// did: the model it ran on (from the helper's own request event), the plugin's
// timing, the helper's message and the gate result.
//
//   npm run eval:live -- --models vercel-ai-gateway/openai/gpt-6-luna [--runs 2]
//
// The model under test has to be the model the deployed build pins, or the run
// refuses before spending a model turn (see deployment.ts). Exits 1 on a gate
// failure against evals/thresholds.json, 2 when it had to refuse to run.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { thresholds } from "../fixtures/load.ts";
import { scoreFormat } from "../scorer/format-score.ts";
import { archiveThread, providerModels, spawnThread, statusProject, threadEvents, threadExists } from "./bb-cli.ts";
import { deployedWalkthroughPlugin, PreflightRefusal, requireMeasurable } from "./deployment.ts";
import { assertDirty, createFixtureRepo } from "./fixture-repo.ts";
import { gateFailures, gateRun, type Thresholds } from "./gate.ts";
import { observeThread } from "./observe.ts";
import { closeDatabase, removeWalkthrough, walkthroughForThread, type WalkthroughRecord } from "./record.ts";
import { markdownReport, type RunReport } from "./report.ts";

/** The ask a person makes, verbatim: the only prompt a run sends. */
const ASK = "Give me a walkthrough of my uncommitted changes in this repo (staged and unstaged).";
const REPORT_DIR = fileURLToPath(new URL("../report/", import.meta.url));

class UsageError extends Error {}

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
}

function options(name: string): string[] {
  const found: string[] = [];
  for (const [index, arg] of process.argv.entries()) {
    if (arg !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    found.push(...value.split(",").map((item) => item.trim()).filter((item) => item !== ""));
  }
  return found;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seconds(ms: number | undefined): number | null {
  return typeof ms === "number" ? Number((ms / 1000).toFixed(1)) : null;
}

/** A stable directory name for a model id. */
const slug = (model: string) => model.replace(/[^a-z0-9.]+/giu, "-").replace(/^-|-$/gu, "");

/** Waits for the scratch thread's agent to open a walkthrough and for its plan turn to settle. */
async function awaitPlan(threadId: string, planTimeoutMs: number, settleTimeoutMs: number): Promise<WalkthroughRecord> {
  const opened = Date.now() + planTimeoutMs;
  let record = walkthroughForThread(threadId);
  while (record === null && Date.now() < opened) {
    await sleep(1000);
    record = walkthroughForThread(threadId);
  }
  if (record === null) throw new Error(`no walkthrough was opened within ${Math.round(planTimeoutMs / 1000)} s`);
  // The record exists: from here the helper is reading and writing.
  const settled = Date.now() + settleTimeoutMs;
  let sawRequestInFlight = false;
  for (;;) {
    const current: WalkthroughRecord = walkthroughForThread(threadId) ?? record;
    record = current;
    if (current.timing.part1Ready !== undefined) return current;
    if (current.status === "failed" || current.status === "done") return current;
    if (current.inFlight !== null) sawRequestInFlight = true;
    // A plan turn that ended without walkthrough_plan leaves nothing in flight and no parts; the plugin queues nothing more.
    else if (sawRequestInFlight && current.parts.length === 0) return current;
    if (Date.now() > settled) throw new Error(`the plan turn did not settle within ${Math.round(settleTimeoutMs / 1000)} s (status ${current.status})`);
    await sleep(1000);
  }
}

async function runOnce(input: {
  model: string;
  run: number;
  provider: string;
  project: string;
  runsPerModel: number;
  thresholds: Thresholds;
  planTimeoutMs: number;
  settleTimeoutMs: number;
  workspace: string;
  keep: boolean;
}): Promise<RunReport> {
  const label = `${slug(input.model)} #${input.run}/${input.runsPerModel}`;
  const dir = join(input.workspace, `${slug(input.model)}-${input.run}`);
  const report: RunReport = {
    modelRequested: input.model,
    run: input.run,
    walkthroughId: null,
    modelRan: null,
    planned: false,
    seconds: { firstWords: null, plan: null, part1: null },
    sincePlanRequest: { firstWords: null, plan: null, part1: null },
    streamedMessageBeforeTool: null,
    format: null,
    partCount: 0,
    partTitles: [],
    walkthroughStatus: null,
    threads: { user: "", helper: null },
    archived: { user: false, helper: null },
    recordRemoved: false,
    error: null,
    checks: [],
    failures: [],
  };

  const repo = createFixtureRepo(dir);
  assertDirty(repo);
  console.log(`  ${label}: wrote the fixture repo, spawning a scratch thread`);
  const threadId = spawnThread({ prompt: ASK, environment: repo.dir, title: `Walkthrough eval: ${input.model.split("/").slice(-1)[0]} #${input.run}`, project: input.project });
  report.threads.user = threadId;

  try {
    const record = await awaitPlan(threadId, input.planTimeoutMs, input.settleTimeoutMs);
    report.walkthroughId = record.id;
    report.walkthroughStatus = record.status;
    report.partCount = record.parts.length;
    report.partTitles = record.parts.map((part) => part.title);
    report.planned = record.timing.planned !== undefined;
    report.seconds = { firstWords: seconds(record.timing.firstText), plan: seconds(record.timing.planned), part1: seconds(record.timing.part1Ready) };
    // The same stages from the plan request, so a run is comparable with the numbers in docs/latency.md.
    const from = (stage: number | undefined): number | null => (stage === undefined || record.timing.planSent === undefined ? null : seconds(stage - record.timing.planSent));
    report.sincePlanRequest = { firstWords: from(record.timing.firstText), plan: from(record.timing.planned), part1: from(record.timing.part1Ready) };
    report.threads.helper = record.workerThreadId;

    if (record.workerThreadId !== null && threadExists(record.workerThreadId)) {
      const observed = observeThread(threadEvents(record.workerThreadId));
      report.modelRan = observed.modelRan;
      report.streamedMessageBeforeTool = observed.streamedMessageBeforeTool;
      report.format = observed.message === null ? null : scoreFormat(observed.message);
    }
    console.log(
      `  ${label}: ${report.walkthroughStatus}, ran ${report.modelRan ?? "no turn"}, first words ${report.seconds.firstWords ?? "–"} s, plan ${report.seconds.plan ?? "–"} s, part 1 ${report.seconds.part1 ?? "–"} s`,
    );
  } catch (cause) {
    report.error = cause instanceof Error ? cause.message : String(cause);
    console.log(`  ${label}: ${report.error}`);
  } finally {
    report.archived.user = archiveThread(threadId);
    if (report.threads.helper !== null && report.threads.helper !== threadId && threadExists(report.threads.helper)) {
      report.archived.helper = archiveThread(report.threads.helper);
    }
    if (report.walkthroughId !== null) report.recordRemoved = removeWalkthrough(report.walkthroughId, threadId);
  }

  report.checks = gateRun(report, input.thresholds);
  report.failures = gateFailures(report.checks, input.thresholds).map((outcome) => outcome.name);
  if (!input.keep) rmSync(dir, { recursive: true, force: true });
  return report;
}

async function main(): Promise<number> {
  const models = options("models");
  if (models.length === 0) throw new UsageError("give the models to measure: --models <catalog id>[,<catalog id>]");
  const runsPerModel = Number(option("runs", "2"));
  if (!Number.isInteger(runsPerModel) || runsPerModel < 1) throw new UsageError("--runs must be a positive whole number");
  const provider = option("provider", "pi");
  const project = option("project", statusProject());
  const limits = thresholds();
  const startedAt = new Date().toISOString();

  // Preflight: the deployed build has to pin every model under test, and the
  // provider has to serve it, before any model turn is spent.
  const catalog = providerModels(provider);
  const deployed = deployedWalkthroughPlugin();
  for (const model of models) requireMeasurable(model, provider, catalog, deployed);
  console.log(`\nWalkthrough helper eval (live): ${models.length} model${models.length === 1 ? "" : "s"}, ${runsPerModel} run${runsPerModel === 1 ? "" : "s"} each`);
  console.log(`deployed plugin ${deployed.root} pins HELPER_MODELS = ${JSON.stringify(deployed.helperModels)} (${deployed.readFrom})`);

  const workspace = mkdtempSync(join(tmpdir(), "walkthrough-eval-"));
  const runs: RunReport[] = [];
  try {
    for (const model of models) {
      console.log(`\n${model}`);
      for (let run = 1; run <= runsPerModel; run += 1) {
        runs.push(
          await runOnce({
            model,
            run,
            provider,
            project,
            runsPerModel,
            thresholds: limits,
            planTimeoutMs: Number(option("plan-timeout", "180")) * 1000,
            settleTimeoutMs: Number(option("settle-timeout", "240")) * 1000,
            workspace,
            keep: process.argv.includes("--keep"),
          }),
        );
      }
    }
  } finally {
    closeDatabase();
    if (!process.argv.includes("--keep")) rmSync(workspace, { recursive: true, force: true });
  }

  const finishedAt = new Date().toISOString();
  const failed = runs.filter((run) => run.failures.length > 0 || run.error !== null);
  const stamp = startedAt.replace(/[:.]/gu, "-");
  mkdirSync(REPORT_DIR, { recursive: true });
  const markdown = markdownReport({ startedAt, finishedAt, provider, runsPerModel, deployed, thresholds: limits, runs });
  const json = join(REPORT_DIR, `live-${stamp}.json`);
  writeFileSync(json, `${JSON.stringify({ startedAt, finishedAt, provider, runsPerModel, deployed, thresholds: limits, runs }, null, 2)}\n`);
  const markdownFile = join(REPORT_DIR, `live-${stamp}.md`);
  writeFileSync(markdownFile, markdown);

  console.log(`\n${markdown}`);
  console.log(`report: ${json}`);
  console.log(`report: ${markdownFile}\n`);
  console.log(`${runs.length - failed.length} of ${runs.length} runs passed the gate`);
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (cause) {
  if (cause instanceof PreflightRefusal || cause instanceof UsageError) {
    console.error(`\n${cause.message}\n`);
    process.exitCode = 2;
  } else {
    console.error(cause);
    process.exitCode = 3;
  }
}
