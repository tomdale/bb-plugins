The change gives retry a ceiling: `RetryOptions` grew an optional `maxAttempts`, defaulting to three, and the loop throws a `RetryExhaustedError` carrying the failure it gave up on.

```walkthrough
part: 1
```

The cap sits on the options object so a caller can raise or lower it without recompiling a constant.

```walkthrough
path: src/retry.ts
lines: 1-6
view: diff
caption: The new default and option, in retry.ts
note 1: Shared so tests and callers reference the same number.
```

```walkthrough
suggestions:
Why check the cap before calling onAttempt?
What happens if maxAttempts is 1?
```
