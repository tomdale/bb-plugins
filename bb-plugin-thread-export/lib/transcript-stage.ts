/**
 * Driving bb's own transcript before the snapshot.
 *
 * ThreadChat renders bb's real timeline, but a long thread arrives one page at
 * a time and the "Load older messages" control is the only way to ask for the
 * next page from a transcript without a composer. These helpers press it until
 * the whole thread is on the page, then wait for the rows to stop changing so
 * the clone is not taken mid-render.
 */

const LOAD_OLDER_LABEL = "older";

/** Older-row pages a single export will request before giving up. */
export const MAX_LOAD_ROUNDS = 80;
const ROUND_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The timeline's own "Load older messages" control, when bb is offering it. */
export function findLoadOlderButton(root: ParentNode): HTMLButtonElement | null {
  for (const button of Array.from(root.querySelectorAll("button"))) {
    const label = (button.textContent ?? "").trim().toLowerCase();
    if (label.includes(LOAD_OLDER_LABEL)) return button;
  }
  return null;
}

export interface LoadOlderMessagesResult {
  /** Pages requested. */
  rounds: number;
  /** True when the control is gone, meaning the thread is complete. */
  exhausted: boolean;
}

/**
 * Clicks "Load older messages" until bb stops offering it. Each click fetches
 * one page, so this is bounded by MAX_LOAD_ROUNDS and by the caller's cancel
 * signal rather than by wall-clock time alone.
 */
export async function loadOlderMessages(
  root: ParentNode,
  options: {
    isCancelled?: () => boolean;
    maxRounds?: number;
    /** Called after each requested page, so the panel can show progress. */
    onProgress?: (rounds: number) => void;
  } = {},
): Promise<LoadOlderMessagesResult> {
  const maxRounds = options.maxRounds ?? MAX_LOAD_ROUNDS;
  const isCancelled = options.isCancelled ?? (() => false);
  let rounds = 0;
  while (rounds < maxRounds && !isCancelled()) {
    const button = findLoadOlderButton(root);
    if (button === null) return { rounds, exhausted: true };
    if (button.disabled) {
      await delay(ROUND_DELAY_MS);
      continue;
    }
    button.click();
    rounds += 1;
    options.onProgress?.(rounds);
    await delay(ROUND_DELAY_MS);
  }
  return { rounds, exhausted: findLoadOlderButton(root) === null };
}

export interface WaitForStableOptions {
  intervalMs?: number;
  /** Consecutive identical samples required before the tree counts as settled. */
  samples?: number;
  timeoutMs?: number;
}

/**
 * Waits until the subtree's shape stops changing. Rows arrive from React
 * commits and stream in after that, so a single rAF is not enough.
 */
export async function waitForStableTree(
  root: ParentNode,
  options: WaitForStableOptions = {},
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 120;
  const required = options.samples ?? 3;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const shape = () => root.querySelectorAll("*").length;
  const started = Date.now();
  let previous = -1;
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const current = shape();
    stable = current === previous ? stable + 1 : 0;
    if (stable >= required) return true;
    previous = current;
    await delay(intervalMs);
  }
  return false;
}
