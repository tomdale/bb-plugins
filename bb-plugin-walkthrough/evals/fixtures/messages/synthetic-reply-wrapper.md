:::reply{kind="answer"}
<!-- walkthrough:start -->
Before this change, `withRetry` had no ceiling: it caught every rejection, waited out a doubling backoff, and called again, forever.

Now retry stops at a cap. `RetryOptions` grew an optional `maxAttempts`, defaulting to three.

```walkthrough
part: 1
```

The cap lives on the options object rather than in a module constant.

```walkthrough
path: src/retry.ts
lines: 1-6
view: diff
caption: The new default and option, in retry.ts
```

```walkthrough
suggestions:
Why check the cap before calling onAttempt?
What happens if maxAttempts is 1?
```
:::
