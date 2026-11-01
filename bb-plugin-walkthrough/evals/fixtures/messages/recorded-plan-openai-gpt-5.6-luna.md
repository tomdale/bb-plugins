<!-- walkthrough:start -->
Before these edits, `withRetry` retried forever, so `drain` could only return successful jobs. The staged retry changes add a three-attempt default, a typed exhaustion error, and an optional cap; the staged test checks that the cap is enforced.

The unstaged queue change consumes that new failure boundary: successful jobs still produce values, while exhausted jobs become results carrying the error and other unexpected errors still escape. I’ll first trace the retry state machine and its test, then follow how queue draining translates exhaustion into per-job results, and finish with the contract and edge cases implied by the new result shape.

```walkthrough
part: 1
```

The central behavioral shift is the new attempt cap in `withRetry`. Each rejected call increments `attempt`; if that count reaches `maxAttempts`—or the default of three—the function throws `RetryExhaustedError` with the final failure attached as `lastError`. Otherwise it invokes `onAttempt`, waits using the existing exponential backoff, and tries again. This means the callback still describes retries, not the terminal failure.

The staged test exercises the default path with a function that always rejects. It verifies both observable effects: the rejection message reports three attempts, and the function was called exactly `DEFAULT_MAX_ATTEMPTS` times. The queue’s later handling depends on this specific error type rather than catching every failure, which preserves propagation for unrelated programming or infrastructure errors.

```walkthrough
path: src/retry.ts
lines: 1-45
view: diff
caption: Capping retries and naming exhaustion
note 1: The default makes the previously unbounded loop finite.
note 17: This error carries the final underlying failure.
note 33: The terminal attempt skips the retry callback and sleep.
```

```walkthrough
path: test/retry.test.ts
lines: 1-8
view: code
caption: Verifying the default attempt cap
note 4: The test uses the default rather than supplying maxAttempts.
note 7: Both the error text and invocation count are asserted.
```

```walkthrough
suggestions:
What does onAttempt receive on the final failed call?
What happens if maxAttempts is set to zero?
Why does the error keep lastError instead of using it as the cause?
``]