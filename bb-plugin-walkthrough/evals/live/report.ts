// The live layer's report: one row per run, then one row per model. The table is
// the answer to "did this model work, and how fast", so every column comes from
// the recorded run: the model from the helper's own request event, the times from
// the walkthrough record's timing, the format verdict from the scorer.
import type { FormatScore } from "../scorer/format-score.ts";
import type { CheckOutcome, GatedRun, Thresholds } from "./gate.ts";
import type { DeployedPlugin } from "./deployment.ts";

export interface RunReport extends GatedRun {
  run: number;
  /** The same stages measured from the plan request rather than the ask, the basis docs/latency.md quotes. */
  sincePlanRequest: { firstWords: number | null; plan: number | null; part1: number | null };
  walkthroughId: string | null;
  walkthroughStatus: string | null;
  partTitles: string[];
  threads: { user: string; helper: string | null };
  archived: { user: boolean; helper: boolean | null };
  /** Whether the walkthrough record the run created was removed again, leaving the pane's recent list as it was. */
  recordRemoved: boolean;
  error: string | null;
  checks: CheckOutcome[];
  failures: string[];
}

export interface ReportInput {
  startedAt: string;
  finishedAt: string;
  provider: string;
  runsPerModel: number;
  deployed: DeployedPlugin;
  thresholds: Thresholds;
  runs: RunReport[];
}

const cell = (value: string | number | null): string => (value === null ? "–" : String(value));

/** A model id short enough for a table cell: the provider's own scoping kept, nothing dropped. */
const shortModel = (model: string): string => model.replace(/^vercel-ai-gateway\//u, "");

function formatCell(score: FormatScore | null): string {
  if (score === null) return "–";
  if (score.ok) return "ok";
  return `findings: ${score.findings.join(", ") || "shape"}`;
}

export function markdownReport(input: ReportInput): string {
  const deployed = input.deployed;
  const lines: string[] = [
    "# Walkthrough helper eval (live)",
    "",
    `${input.startedAt} to ${input.finishedAt}, ${input.runsPerModel} run${input.runsPerModel === 1 ? "" : "s"} per model on the \`${input.provider}\` provider.`,
    "",
    `Deployed plugin \`${deployed.root}\` pins HELPER_MODELS = ${deployed.helperModels.map((model) => `\`${model}\``).join(", ")} (read from \`${deployed.readFrom}\`${deployed.build === null ? "" : `, present in \`${deployed.build}\``}). Each run's row names the model the helper's own request event reported.`,
    "",
    "| Model requested | Run | Model that ran | First words | Plan | Part 1 | Message before call | Format | Parts | Gate |",
    "|---|---:|---|---:|---:|---:|---|---|---:|---|",
    ...input.runs.map((run) => {
      const ran = run.modelRan === null ? "–" : `${shortModel(run.modelRan)} ${run.modelRan === run.modelRequested ? "✓" : "✗"}`;
      const message =
        run.streamedMessageBeforeTool === null ? (run.planned ? "not recorded" : "no plan call") : run.streamedMessageBeforeTool ? "yes" : "no";
      const gate = run.error !== null ? `error: ${run.error}` : run.failures.length === 0 ? "pass" : `fail: ${run.failures.join(", ")}`;
      return `| \`${shortModel(run.modelRequested)}\` | ${run.run} | ${ran} | ${cell(run.seconds.firstWords)} | ${cell(run.seconds.plan)} | ${cell(run.seconds.part1)} | ${message} | ${formatCell(run.format)} | ${run.partCount} | ${gate} |`;
    }),
    "",
    "| Model | Runs | Passed | Median part 1 |",
    "|---|---:|---:|---:|",
  ];
  for (const model of [...new Set(input.runs.map((run) => run.modelRequested))]) {
    const runs = input.runs.filter((run) => run.modelRequested === model);
    const passed = runs.filter((run) => run.failures.length === 0 && run.error === null).length;
    const partOnes = runs.map((run) => run.seconds.part1).filter((value): value is number => value !== null).sort((a, b) => a - b);
    const median = partOnes.length === 0 ? null : partOnes[Math.floor(partOnes.length / 2)]!;
    lines.push(`| \`${shortModel(model)}\` | ${runs.length} | ${passed} | ${median === null ? "–" : `${median} s`} |`);
  }
  const failures = input.runs.filter((run) => run.failures.length > 0 || run.error !== null);
  if (failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const run of failures) {
      const detail =
        run.error ??
        run.checks
          .filter((outcome) => outcome.status === "fail")
          .map((outcome) => `${outcome.name} (${outcome.detail})`)
          .join("; ");
      lines.push(`- Run ${run.run} of \`${run.modelRequested}\`: ${detail}`);
    }
  }
  lines.push(
    "",
    `First words, plan and part 1 are seconds after the ask, from the walkthrough record's timing; the JSON also carries each stage measured from the plan request (\`sincePlanRequest\`).`,
    "",
    `Thresholds: plan within ${input.thresholds.maxSecondsToPlan} s, part 1 within ${input.thresholds.maxSecondsToPart1} s; required checks ${input.thresholds.requiredChecks.join(", ")}. An "unknown" check has no observation and does not pass a run.`,
    "",
  );
  return lines.join("\n");
}
