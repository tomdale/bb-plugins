// The fixture a live run walks through: two small TypeScript modules and a
// test, with one uncommitted change (a retry cap). The tree is written here
// rather than kept as a checked-in repo, and it reproduces exactly the fixture
// the HELPER_MODELS measurements used, so new numbers stay comparable with the
// ones in docs/latency.md and a run needs no machine-local state.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RETRY_BASE = `export interface RetryOptions {
  baseDelayMs: number;
  onAttempt?: (attempt: number, error: unknown) => void;
}

export function backoffDelay(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** (attempt - 1);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs \`fn\` until it resolves; every rejection is retried after a backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      options.onAttempt?.(attempt, error);
      await sleep(backoffDelay(attempt, options.baseDelayMs));
    }
  }
}
`;

const QUEUE_BASE = `import { withRetry } from "./retry.ts";

export interface Job<T> {
  id: string;
  run: () => Promise<T>;
}

export interface DrainResult<T> {
  id: string;
  value: T;
}

/** Drains jobs in order, retrying each one until it settles. */
export async function drain<T>(jobs: Job<T>[]): Promise<DrainResult<T>[]> {
  const results: DrainResult<T>[] = [];
  for (const job of jobs) {
    const value = await withRetry(job.run, { baseDelayMs: 50 });
    results.push({ id: job.id, value });
  }
  return results;
}
`;

/** The uncommitted change: an attempt cap, the error it throws, and the queue that records it. */
const CHANGED: Record<string, string> = {
  "src/retry.ts": `export const DEFAULT_MAX_ATTEMPTS = 3;

export interface RetryOptions {
  baseDelayMs: number;
  maxAttempts?: number;
  onAttempt?: (attempt: number, error: unknown) => void;
}

export function backoffDelay(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** (attempt - 1);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryExhaustedError extends Error {
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(\`gave up after \${attempts} attempts: \${String(lastError)}\`);
    this.name = "RetryExhaustedError";
    this.lastError = lastError;
  }
}

/** Runs \`fn\` until it resolves or the attempt cap is reached. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts) {
        throw new RetryExhaustedError(attempt, error);
      }
      options.onAttempt?.(attempt, error);
      await sleep(backoffDelay(attempt, options.baseDelayMs));
    }
  }
}
`,
  "src/queue.ts": `import { RetryExhaustedError, withRetry } from "./retry.ts";

export interface Job<T> {
  id: string;
  run: () => Promise<T>;
}

export interface DrainResult<T> {
  id: string;
  value?: T;
  error?: unknown;
}

/** Drains jobs in order, retrying each one until it settles or gives up. */
export async function drain<T>(jobs: Job<T>[]): Promise<DrainResult<T>[]> {
  const results: DrainResult<T>[] = [];
  for (const job of jobs) {
    try {
      const value = await withRetry(job.run, { baseDelayMs: 50 });
      results.push({ id: job.id, value });
    } catch (error) {
      if (!(error instanceof RetryExhaustedError)) throw error;
      results.push({ id: job.id, error });
    }
  }
  return results;
}
`,
  "test/retry.test.ts": `import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_ATTEMPTS, withRetry } from "../src/retry.ts";
test("withRetry gives up after DEFAULT_MAX_ATTEMPTS", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new Error("boom"); }, { baseDelayMs: 1 }), /gave up after 3 attempts/);
  assert.equal(calls, DEFAULT_MAX_ATTEMPTS);
});
`,
};

/** Files staged in the change; src/queue.ts is left unstaged so the walkthrough sees both kinds. */
const STAGED = ["src/retry.ts", "test/retry.test.ts"];

export interface FixtureRepo {
  dir: string;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Walkthrough Eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 24 });
}

export function createFixtureRepo(dir: string): FixtureRepo {
  mkdirSync(dir, { recursive: true });
  const write = (relative: string, content: string) => {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  };
  write("src/retry.ts", RETRY_BASE);
  write("src/queue.ts", QUEUE_BASE);
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "Add retry and queue modules");
  for (const [relative, content] of Object.entries(CHANGED)) write(relative, content);
  git(dir, "add", ...STAGED);
  return { dir };
}

/** Fails the run early when the fixture has no uncommitted work, which would make the walkthrough empty. */
export function assertDirty(repo: FixtureRepo): void {
  const status = git(repo.dir, "status", "--porcelain").trim();
  if (status === "") throw new Error(`the fixture repo at ${repo.dir} has no uncommitted change, so a walkthrough of it would be empty`);
}
