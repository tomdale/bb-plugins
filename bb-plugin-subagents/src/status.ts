import type { Run } from "./contracts.ts";

/** A run that is still doing work, whoever controls it. */
export function runIsWorking(run: Pick<Run, "status">): boolean {
  return run.status === "starting" || run.status === "running";
}

export type RunTone = "running" | "success" | "error" | "attention" | "muted";

/** Semantic treatment for one run, shared by every status surface. */
export function runTone(run: Pick<Run, "status" | "control">): RunTone {
  if (run.control === "user") return "attention";
  switch (run.status) {
    case "starting":
    case "running":
      return "running";
    case "completed":
      return run.control === "returned" ? "muted" : "success";
    default:
      return "error";
  }
}

export function runStatusLabel(run: Pick<Run, "status" | "control">): string {
  if (run.control === "user") return "User controlled";
  switch (run.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "killed":
      return "Stopped";
    case "timed-out":
      return "Timed out";
  }
}

export interface RunSummary {
  /** Working runs the agent controls. */
  working: number;
  /** Runs the user has taken control of. */
  userControlled: number;
  /** Runs that ended in failure, kill, or timeout. */
  failed: number;
  /** Runs that ended successfully or were returned by the user. */
  settled: number;
}

export function summarizeRuns(runs: readonly Pick<Run, "status" | "control">[]): RunSummary {
  const summary: RunSummary = { working: 0, userControlled: 0, failed: 0, settled: 0 };
  for (const run of runs) {
    if (run.control === "user") summary.userControlled++;
    else if (runIsWorking(run)) summary.working++;
    else if (run.status === "completed") summary.settled++;
    else summary.failed++;
  }
  return summary;
}

/** One short count line, omitting zeros, for the header action's label and the panel summary. */
export function summaryLine(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.working > 0) parts.push(`${summary.working} running`);
  if (summary.userControlled > 0) parts.push(`${summary.userControlled} user-controlled`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.settled > 0) parts.push(`${summary.settled} completed`);
  return parts.join(" · ");
}
