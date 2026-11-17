/**
 * Timeout schedule for a background worker.
 *
 * The timeout is the moment a worker must start winding down, not the moment it
 * is cut off: at the deadline it is told to stop starting new work and report,
 * and it is hard-stopped only after a grace period that scales with the
 * timeout. A longer timeout also earns earlier heads-up notices, so a worker
 * planning hours of work sees its budget shrinking well before the deadline.
 */

const GRACE_FRACTION = 0.1;
const MIN_GRACE_MS = 30_000;
const MAX_GRACE_MS = 600_000;

/** Heads-up notices fire this many grace periods before the deadline. */
const NOTICE_GRACE_MULTIPLES = [8, 4, 2];

export interface TimeoutSchedule {
  deadline: number;
  graceMs: number;
  /** Timestamps of heads-up notices still to send, in ascending order. */
  notices: number[];
}

export function graceMsFor(timeoutMs: number): number {
  return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, Math.round(timeoutMs * GRACE_FRACTION)));
}

/**
 * Schedules a deadline `timeoutMs` after `startedAt`. A notice is only worth
 * sending when it falls in the second half of the budget; shorter timeouts
 * therefore get fewer notices, and the shortest get only the wind-down order.
 */
export function scheduleTimeout(startedAt: number, timeoutMs: number): TimeoutSchedule {
  const graceMs = graceMsFor(timeoutMs);
  const deadline = startedAt + timeoutMs;
  const notices = NOTICE_GRACE_MULTIPLES.map(multiple => multiple * graceMs)
    .filter(lead => lead <= timeoutMs / 2)
    .map(lead => deadline - lead);
  return { deadline, graceMs, notices };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return `${hours} hours`;
}

/** "24-hour", for use before a noun. */
function durationAdjective(ms: number): string {
  return formatDuration(ms).replace(/s$/, "").replace(" ", "-");
}

/**
 * Time-check text for a notice sent `remainingMs` before the deadline. The
 * tone follows how many grace periods remain (8, 4 or 2 when sent on schedule),
 * so each notice asks for more than the last. Ratios between the scheduled
 * points pick the nearer stage, which keeps a late or batched notice sensible.
 */
export function noticeMessage(remainingMs: number, timeoutMs: number, graceMs: number): string {
  const graces = remainingMs / graceMs;
  const head = `Time check: about ${formatDuration(remainingMs)} remain of your ${durationAdjective(timeoutMs)} budget.`;
  if (graces > 6) {
    return `${head} Keep going, and make sure the highest-value work gets done first.`;
  }
  if (graces > 3) {
    return `${head} Stop starting large new pieces of work and begin finishing what is in progress.`;
  }
  return `${head} Finish your current step soon and be ready to wrap up. At the deadline you will be asked to report what is done and what remains.`;
}

export function windDownMessage(graceMs: number): string {
  return `Time limit reached. Stop starting new work. Finish or safely abandon your current step and leave files in a consistent state. Begin your reply with COMPLETE if the task is fully done or INCOMPLETE if it is not, then say what is done, what remains, and how to continue. You will be stopped in about ${formatDuration(graceMs)}; your owner may resume you later.`;
}

/**
 * Reads the verdict a worker gives at the start of its wrap-up reply. A reply
 * without a clear COMPLETE counts as incomplete: only an explicit claim of
 * completion may settle a run that ran out of time as completed.
 */
export function declaresComplete(reply: string): boolean {
  const firstLine = reply
    .split("\n")
    .map(line => line.replace(/^:{3,}.*$/, "").replace(/[*_`#>\s]+/g, " ").trim())
    .find(line => line.length > 0);
  return firstLine !== undefined && /^COMPLETE\b/i.test(firstLine);
}

export type SettledStatus = "completed" | "failed" | "timed-out" | "killed";

/** The message a resumed worker receives; a completed worker needs steering, since it has nothing left to continue. */
export function resumeMessage(previous: SettledStatus, steering?: string): string {
  const preface = {
    "timed-out": "Your time limit expired and you were paused. You have a new time budget; continue the task where you left off.",
    killed: "You were stopped before finishing. You have a new time budget; continue the task where you left off.",
    failed: "Your previous attempt ended in a failure. You have a new time budget; check where things stand and continue the task.",
    completed: "You finished your task earlier. You have a new time budget for follow-up work.",
  }[previous];
  return steering ? `${preface}\n\nNew instructions from your owner:\n${steering}` : preface;
}
