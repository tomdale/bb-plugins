<!-- walkthrough:start -->
Before this change, `withRetry` had no ceiling: it caught every rejection, waited out a doubling backoff, and called again, forever. A job that failed permanently pinned the loop open, and `drain` in `src/queue.ts`, which awaited it, hung with it.

Now retry stops at a cap. `RetryOptions` grew an optional `maxAttempts`, defaulting to three, and the loop throws a `RetryExhaustedError` that carries the failure it gave up on. `drain` catches that one error type and records it as the job's outcome, so a bad job no longer takes the queue with it.

```walkthrough
part: 1
```

## Part 1: Retry gets a ceiling

The cap lives on the options object rather than in a module constant so a caller can raise or lower it, while `DEFAULT_MAX_ATTEMPTS` keeps the default importable by the test.

```walkthrough
path: src/retry.ts
lines: 1-6
view: diff
caption: The new default and option, in retry.ts
note 1: Shared so tests and callers reference the same number.
```

The check comes after the counter increments and before the callback and the sleep, so the third failure throws without waiting out a delay for a retry that will never happen.

```walkthrough
suggestions:
Why check the cap before calling onAttempt?
What happens if maxAttempts is 1?
Does the backoff still apply on the last failed attempt?
```
