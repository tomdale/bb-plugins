<!-- walkthrough:start -->
Before this change, `withRetry` had no ceiling: it caught every rejection, waited out a doubling backoff, and called again, forever. A job that failed permanently pinned the loop open, and `drain` in `src/queue.ts`, which awaited it, hung with it.

Now retry stops at a cap. `RetryOptions` grew an optional `maxAttempts`, defaulting to three, and the loop throws a `RetryExhaustedError` that carries the failure it gave up on.

```walkthrough
part: 1
```

The cap lives on the options object rather than in a module constant, so a caller can raise or lower it ([the default](src/retry.ts:1), [the option](src/retry.ts:5)). The check runs after the counter increments and before the callback, so the third failure throws without waiting out a delay ([the check](src/retry.ts:39)).

```walkthrough
suggestions:
Why check the cap before calling onAttempt?
What happens if maxAttempts is 1?
Does the backoff still apply on the last failed attempt?
```
