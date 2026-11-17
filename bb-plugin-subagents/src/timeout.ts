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

export function noticeMessage(remainingMs: number, timeoutMs: number): string {
  return `Time check: about ${formatDuration(remainingMs)} remain of your ${formatDuration(timeoutMs)} budget. Prioritize the work that matters most and be ready to wrap up.`;
}

export function windDownMessage(graceMs: number): string {
  return `Time limit reached. Stop starting new work. Finish or safely abandon your current step, leave files in a consistent state, and reply with what is done, what remains, and how to continue. You will be stopped in about ${formatDuration(graceMs)}; your owner may resume you later.`;
}

export function resumeMessage(previous: "timed-out" | "killed", steering?: string): string {
  const preface =
    previous === "timed-out"
      ? "Your time limit expired and you were paused. You have a new time budget; continue the task where you left off."
      : "You were stopped before finishing. You have a new time budget; continue the task where you left off.";
  return steering ? `${preface}\n\nNew instructions from your owner:\n${steering}` : preface;
}
