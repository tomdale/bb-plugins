<!-- walkthrough:start -->
Before this change, `withRetry` was a promise that never gave up: it caught every rejection, waited out a doubling backoff, and called `fn` again, forever. Any function that failed permanently would spin and sleep until the process died. `drain` in `src/queue.ts` had the same shape from the outside — it awaited each job through `withRetry` and pushed a `{ id, value }` result, so a single bad job hung the whole queue and no result ever came back.

The change gives retry a ceiling. `withRetry` now counts attempts, stops at a cap (`3` by default, overridable per call), and rejects with a typed `RetryExhaustedError` that carries the original failure. `drain` catches exactly that error type and records it against the job instead of letting it escape, so one dead job no longer takes the drain with it. A new test pins the attempt count so the cap can't silently drift.

The pieces read in that order: the cap and the error type in `src/retry.ts`, the test that fixes the number, then the queue's new per-job catch.

```walkthrough
part: 1
```

The cap lives in one place, and it is optional: callers that pass nothing get `DEFAULT_MAX_ATTEMPTS`. That keeps the existing call in `drain`, which only passes `baseDelayMs`, working unchanged while still gaining a limit.

```walkthrough
path: src/retry.ts
lines: 1-7
view: diff
caption: The default and the new option, in retry.ts
note 1: Exported so callers and tests can name the same number.
note 5: Omitted means "use the default", not "unlimited".
```

The loop counts a failure, then checks the cap. Because the counter increments before the comparison, `maxAttempts: 3` means three actual calls to `fn`: the first two failures sleep and retry, the third throws. The check sits ahead of `onAttempt`, so the final failure reaches the caller through the error rather than the progress hook — you hear about attempts 1 and 2 only.

```walkthrough
path: src/retry.ts
lines: 32-46
view: diff
caption: Counting attempts and giving up, in withRetry
note 39: Fails before the hook, so the last error is reported only by the throw.
note 42: onAttempt fires only for attempts that will be retried.
note 43: backoffDelay gives 50ms then 100ms at the queue's base delay; nothing is slept after the last failure.
```

The error itself keeps the original around as `lastError`, which is what lets a caller tell an exhausted retry apart from a bug while still seeing what actually went wrong.

```walkthrough
path: src/retry.ts
lines: 17-25
view: diff
caption: RetryExhaustedError
note 22: Set explicitly so logs and stacks read the class name rather than "Error".
note 23: The thrown value is kept on the instance; it is not wired into `cause`.
```

```walkthrough
suggestions:
Why check `attempt >= maxAttempts` before calling onAttempt?
What happens if a caller passes maxAttempts of 1?
Why not attach lastError as the standard `cause`?
```