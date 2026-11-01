<!-- walkthrough:start -->
Before this change, `withRetry` had no notion of giving up. It called the function, and on every rejection it waited an exponentially growing delay, then called again — forever. Any job whose failure was permanent would pin the loop open, and `drain` in the queue module, which simply awaited `withRetry`, would hang with it.

Now retrying stops after a fixed number of attempts. That limit is a new optional `maxAttempts` on `RetryOptions`, defaulting to three. When the cap is hit, instead of sleeping again, the loop throws a dedicated `RetryExhaustedError` that carries the last underlying failure alongside it.

The second half of the change is what `drain` does with that error. Previously one bad job would reject the whole batch; now `drain` catches exhaustion for the individual job, records it as a result entry, and moves on to the next one. So a batch of jobs always returns a row per job, each holding either a value or an error. A short test then pins the cap so it cannot quietly drift.

```walkthrough
part: 1
```

The cap lives in one place: a module-level [constant](line:1) that anyone can import, and an optional [field on the options](line:5) that lets a caller raise or lower it per call site. Inside the loop, the first line reads the effective limit — the caller's value if present, otherwise the default.

The interesting part is where the check sits. It comes [right after the attempt counter increments](line:39), and before the callback and the sleep. That ordering is what makes "attempts" mean what a reader expects: on the third failure with the default, the counter has just become 3, the loop throws immediately, and no [backoff delay](line:43) is ever waited for a retry that will not happen. It also means `onAttempt` only fires for failures that will genuinely be retried — a third-failure observer never sees the terminal one.

Note the interaction with the delay formula: the delay is computed from the count of the attempt that just failed, so the sleep after failure one is one base unit, after failure two it is two, and so on. Because the cap check runs first, the highest delay actually slept is the one after the second-to-last failure.

```walkthrough
path: src/retry.ts
lines: 1-46
view: diff
caption: The attempt cap, in src/retry.ts
note 1: Shared so tests and callers can reference the same number.
note 39: Without this the loop would wait out a delay before giving up.
note 43: Reached only for failures that will be retried.
```

```walkthrough
suggestions:
Why call onAttempt before the sleep rather than after a failure settles?
What happens if maxAttempts is set to 1 or 0?
Does a caller-supplied baseDelayMs still apply on the fast path?
```