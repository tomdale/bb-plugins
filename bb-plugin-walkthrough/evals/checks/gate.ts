// The live layer's pass/fail policy, replayed against recorded runs: the known
// failure (a message but no walkthrough_plan call) has to fail the gate, and the
// runs that planned have to pass it. This is the part of the live layer that can
// be tested without a model, so it is.
import { recordedRuns, thresholds } from "../fixtures/load.ts";
import { gateFailures, gateRun } from "../live/gate.ts";
import { equal } from "./expect.ts";
import type { Check } from "./check.ts";

const limits = thresholds();

export const gateChecks: Check[] = recordedRuns().map((run) => ({
  name: `gate: ${run.modelRequested.split("/").slice(-2).join("/")} at ${run.seconds.firstWords} s`,
  run() {
    const outcomes = gateRun(run, limits);
    const failures = gateFailures(outcomes, limits).map((outcome) => outcome.name);
    equal(failures, run.expectFailures, `${run.modelRequested} required-check failures`);
    const unknown = outcomes.filter((outcome) => outcome.status === "unknown").map((outcome) => outcome.name);
    return [`${failures.length === 0 ? "passes" : `fails ${failures.join(", ")}`}`, ...(unknown.length > 0 ? [`unknown: ${unknown.join(", ")}`] : [])].join("; ");
  },
}));
