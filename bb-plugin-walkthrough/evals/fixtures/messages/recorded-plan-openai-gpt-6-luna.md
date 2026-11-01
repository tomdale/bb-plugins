<!-- walkthrough:start -->
The retry helper now puts a ceiling on repeated failures, the queue records jobs that hit that ceiling, and a focused test checks the default cap. The retry helper and its test are staged; the queue integration is unstaged, so all three pieces are still part of the uncommitted work.

I’ll start with the retry contract: how the attempt limit is chosen, what happens on the last failure, and what information the new error retains.

```walkthrough
part: 1
```

`withRetry` now defaults to [three total attempts](line:1), while callers can supply a different `maxAttempts` in its options. The counter advances only after a rejection, so the cap includes the initial call—not three retries after it. Until the cap is reached, the helper reports the failed attempt through `onAttempt` and waits for exponential backoff before trying again.

On the final rejection, it throws a [RetryExhaustedError](line:17) instead of sleeping and looping forever. That error keeps the last underlying failure in `lastError` and includes the attempt count in its message. One detail to notice: because the cap check happens first, `onAttempt` is not called for the final, exhausted attempt; it only reports failures that will be retried. The queue’s unstaged change uses this specific error to distinguish normal exhaustion from other errors, which is the next piece.

```walkthrough
path: src/retry.ts
lines: 17-44
view: diff
caption: Capping attempts and reporting exhaustion
note 32: Callers can override the default cap.
note 39: The final failure exits before callback or backoff.
```

```walkthrough
suggestions:
Should onAttempt also report the final failed attempt?
What happens when maxAttempts is zero or negative?
```