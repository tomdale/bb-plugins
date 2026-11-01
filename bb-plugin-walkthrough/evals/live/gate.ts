// The pass/fail policy for one live run, kept apart from the code that runs it
// so the offline layer can test the policy against recorded runs. A check with
// no observation is "unknown", never a pass: a run that never confirmed which
// model it measured, or never saw a tool call to compare the message with, has
// not shown the thing the check is about.
import type { FormatScore } from "../scorer/format-score.ts";

export interface GatedRun {
  modelRequested: string;
  /** The model from the helper's own client/turn/requested event; null when the helper never ran. */
  modelRan: string | null;
  /** Whether the helper called walkthrough_plan in the plan turn. */
  planned: boolean;
  /** Seconds after the ask, for each stage the run reached. */
  seconds: { firstWords: number | null; plan: number | null; part1: number | null };
  /** Whether a message with the start marker was written before the plan call; null when there was no call to compare. */
  streamedMessageBeforeTool: boolean | null;
  /** The scorer's verdict on the helper's plan message; null when no message was recorded. */
  format: FormatScore | null;
  partCount: number;
}

export interface Thresholds {
  maxSecondsToPlan: number;
  maxSecondsToPart1: number;
  /** The checks a run must pass; a failure in one of these fails the run. */
  requiredChecks: readonly string[];
}

export type CheckStatus = "pass" | "fail" | "unknown";

export interface CheckOutcome {
  name: string;
  status: CheckStatus;
  detail: string;
}

function compare(name: string, seconds: number | null, limit: number): CheckOutcome {
  if (seconds === null) return { name, status: "unknown", detail: "the stage was never reached" };
  return { name, status: seconds <= limit ? "pass" : "fail", detail: `${seconds.toFixed(1)} s (max ${limit} s)` };
}

function flag(name: string, value: boolean | null, detail: string): CheckOutcome {
  if (value === null) return { name, status: "unknown", detail };
  return { name, status: value ? "pass" : "fail", detail };
}

/** Every check one run is held to, in report order. */
export function gateRun(run: GatedRun, thresholds: Thresholds): CheckOutcome[] {
  const format = run.format;
  return [
    {
      name: "model",
      status: run.modelRan === null ? "fail" : run.modelRan === run.modelRequested ? "pass" : "fail",
      detail: run.modelRan === null ? "the helper ran no turn" : `ran ${run.modelRan}`,
    },
    flag("planned", run.planned, "the helper never called walkthrough_plan"),
    flag("part1Ready", run.seconds.part1 !== null, "part 1 was never committed"),
    flag("streamedMessageBeforeTool", run.streamedMessageBeforeTool, "no walkthrough_plan call to compare the message with"),
    flag("markerLine", format?.markerLine ?? null, "no message was recorded"),
    flag("partFence", format?.partFence ?? null, "no message was recorded"),
    flag("codeFencesWithPathAndLines", format?.codeFencesWithPathAndLines ?? null, "no message was recorded"),
    flag("suggestionsFence", format?.suggestionsFence ?? null, "no message was recorded"),
    flag("noForbiddenElements", format === null ? null : format.findings.length === 0, format === null ? "no message was recorded" : format.findings.join(", ") || "none found"),
    compare("secondsToPlan", run.seconds.plan, thresholds.maxSecondsToPlan),
    compare("secondsToPart1", run.seconds.part1, thresholds.maxSecondsToPart1),
  ];
}

/**
 * The required checks the run did not pass; empty means it meets the gate. An
 * unknown required check counts: the run never showed the thing the check is
 * about, so it cannot stand in for a passing one.
 */
export function gateFailures(outcomes: readonly CheckOutcome[], thresholds: Thresholds): CheckOutcome[] {
  return outcomes.filter((outcome) => outcome.status !== "pass" && thresholds.requiredChecks.includes(outcome.name));
}
