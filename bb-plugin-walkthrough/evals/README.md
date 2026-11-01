# Walkthrough eval suite

Two layers, one entry point each, for the question the plugin's design turns on:
does the hidden helper agent actually open a walkthrough, write a part in the
markup the pane reads, and do it fast enough to keep the reader waiting?

- `npm run eval` — **offline**. Runs the real service against the fake SDK and
  the committed fixtures. No model, no credentials, no BB server.
- `npm run eval:live` — **live**. Spawns scratch threads on a running BB app,
  asks for a real walkthrough, and records what the helper did and how long it
  took. Needs a `bb` CLI on a machine with provider credentials, and a
  deployment that pins the model under test.

Both write JSON (and, live, Markdown) to `evals/report/`, which is not
committed.

## Offline: `npm run eval`

Runs in a couple of seconds and exits non-zero when a check fails, so a CI job
gates on the same run a person does locally. `--fail-fast` stops at the first
failure.

```sh
npm ci          # once, for the SDK's fake host and better-sqlite3
npm run eval
```

| Check | What it pins |
|---|---|
| streamed message: plan and write commit part 1 from the message | A helper that writes the marker line, the introduction, the `part: 1` fence, code fences and the suggestions fence, then calls `walkthrough_plan` with no `introduction` and `walkthrough_write_part` with only the part number, commits part 1 from that message: the introduction, the blocks with their snapshots, and the suggestions. Also that `part1Ready` is timed. |
| streamed message: a plan turn without walkthrough_plan stays unplanned | The known failure behind `HELPER_MODELS` (deepseek-v4.1-flash and deepseek-v4.1-flash-1017, 0 of 4 plan turns). A plan turn that ends with no tool call leaves the walkthrough in `planning`, no parts, nothing in flight, no queued request, and the raw markup as the walkthrough's `message`; the plugin never retries. The suite pins that dead end instead of inventing a recovery, and pins that the message itself scores clean, so the failure is the missing tool call and not the format. |
| arguments: content passed to the tools commits the part | Without a message, a call with no content fails once with the format and the escape hatch, and the same call with the introduction or blocks as arguments commits the part with snapshots and suggestions. This is the path measured fastest for models that never stream. |
| helper model: a provider serving no preference keeps the thread's model | A catalog with none of `HELPER_MODELS` sends the request anyway, on the thread's own model, at medium reasoning. |
| helper model: a rejected pin falls back to the thread's model | The fallback chain, in order: pinned model at medium, pinned model with no level, the thread's own model at medium. One request is delivered. |
| instructions: every delivered instruction text is under BB's 4096 characters | BB truncates each instruction at 4096 characters, and a truncated instruction silently loses the rule at its end. |
| format: `<fixture>` (one check per fixture) | The scorer's own test: every message in `evals/fixtures/messages/` must get the verdict recorded beside it. |
| gate: `<model>` (one check per recorded run) | The live layer's pass/fail policy, replayed on the recorded live runs: the known failure must fail on `planned` and `part1Ready`, the runs that planned must pass. |

`evals/report/offline.json` holds every check with its status, duration and
error.

## Live: `npm run eval:live`

```sh
npm run eval:live -- --models vercel-ai-gateway/openai/gpt-6-luna [--runs 2]
```

Options: `--models` (comma-separated catalog ids, required), `--runs` (default 2
per model), `--provider` (default `pi`), `--project` (default: this shell's
project), `--plan-timeout` (seconds to wait for a walkthrough to open, default
180), `--settle-timeout` (seconds for the plan turn, default 240), `--keep` (keep
the fixture repos).

Each run:

1. Writes the fixture repo from `evals/live/fixture-repo.ts` into a temp dir:
   `src/retry.ts` and `src/queue.ts` plus a test, with one uncommitted change (an
   attempt cap, staged in two files and unstaged in one). It is the same tree the
   `HELPER_MODELS` measurements used, so the numbers stay comparable with
   `docs/latency.md`.
2. Spawns a hidden scratch thread in that repo and prompts it exactly
   `Give me a walkthrough of my uncommitted changes in this repo (staged and unstaged).`
   and waits for the thread's own agent to call `walkthrough_open`.
3. Waits for the plan turn to settle: part 1 ready, a closed walkthrough, or a
   plan turn that ended with nothing in flight and no parts.
4. Reads the walkthrough record from `~/.bb/plugins/walkthrough/data.db`
   read-only: `timing` gives seconds to first words (`firstText`), to
   `walkthrough_plan` (`planned`) and to part 1 (`part1Ready`), all measured from
   the ask; `parts` gives the titles.
5. Reads the helper thread's own event log: the `client/turn/requested` event for
   the plan request names the model that ran it, and the message and tool-call
   items show whether a marked-up message was written before
   `walkthrough_plan`. The message is scored by the same scorer as the offline
   layer.
6. Archives the scratch thread and its helper, removes the walkthrough record it
   created (so repeated runs leave the pane's list of recent walkthroughs as it
   was), and removes the fixture copy.

### The model under test must be the deployed one

The helper's model comes from `HELPER_MODELS` in `src/service.ts`, read at
request time. There is no outside switch: a running app sends the first
preference its provider lists, from the build it has loaded. So a live run can
only measure the model the deployed build pins.

The runner therefore refuses before spending a model turn when the deployed
plugin's first served preference is not the model asked for (exit 2), naming the
deployed list, the file it read, and the exact steps below. It then verifies per
run, from the helper's own `client/turn/requested` event, that the model that
ran is the model requested; a run that ran something else fails the gate.

Today, measuring a model outside the two Lunas means, in the canonical checkout
the app serves:

1. put the model's preference (the catalog id without the provider prefix, e.g.
   `deepseek/deepseek-v4.1-flash-1017`) first in `HELPER_MODELS` in
   `src/service.ts`
2. `npm run build`
3. `bb plugin reload walkthrough`
4. run the eval
5. restore `HELPER_MODELS`, then rebuild and reload again

The runner reads the preferences from the deployed plugin's `src/service.ts`
(a path-installed plugin is deployed from that checkout) and checks the built
bundle contains every one of them, so a stale build is refused rather than
measured.

### What it costs

One model turn per run for the scratch thread's own agent (a `walkthrough_open`
call), one walkthrough per run (the helper's plan turn, plus reading), and up to
one more helper turn if part 2 gets requested before the thread is archived. Two
runs per model is the default. A run takes 30 to 60 seconds on a fast model and
stops waiting after the timeouts above whatever the model does.

### Thresholds

`evals/thresholds.json` is the regression gate: `maxSecondsToPlan`,
`maxSecondsToPart1`, and the checks a run must pass. A run fails when a required
check fails; a check with no observation is `unknown`, which never passes a run.
`model`, `planned` and `part1Ready` are separate checks on purpose, so a run that
planned but wrote badly is distinguishable from one that never called the tool.

The limits are calibrated on the deployed numbers: gpt-6-luna 20.4 s to plan and
21.9 s to part 1, gpt-5.6-luna 16.6 s and 18.3 s, on a shared machine. 40 s and
60 s leave roughly twice the fastest pinned model's time before a slow machine
turns into a failure.

### Exit codes

| Code | Meaning |
|---:|---|
| 0 | every run passed the gate |
| 1 | a run failed a required check, or the timing threshold |
| 2 | the run refused to start: a model is not in the provider catalog, or the deployed build does not pin it |
| 3 | the run could not complete (no walkthrough opened, the helper thread was unreadable) |

Reports: `evals/report/live-<stamp>.json` and `evals/report/live-<stamp>.md`.

## How CI would use it

- **Every change:** `npm ci && npm run eval`. It needs node only, takes seconds,
  and its failures name the behaviour that broke.
- **On a deployment, by hand or nightly:** pin the model to measure, rebuild,
  reload, `npm run eval:live -- --models <id> --runs 1`, restore. A non-zero exit
  is the regression signal; the committed report and the recorded fixtures in
  `evals/fixtures/recorded-runs.json` are what a new candidate gets compared
  with. The offline layer replays those recordings, so a change to the gate
  shows up without a model run.

## Fixtures

- `evals/fixtures/messages/` — helper messages with the format verdict each one
  must get: four recorded from live runs (both Lunas, and two from
  deepseek-v4.1-flash-1017, whose messages are well formed even though the model
  never called the tool), and five covering the shapes the guide forbids (a
  heading inside a part, prose code links with no figure fences, a missing
  marker line, a `:::reply` wrapper, and the tool-only turn that wrote nothing). `index.json` carries each one's provenance and expected verdict; add
  a recording by dropping in the text and an entry.
- `evals/fixtures/recorded-runs.json` — live runs measured through the deployed
  plugin with the model confirmed from the helper's own request event: both
  Lunas planned and wrote and pass every check; deepseek-v4.1-flash and
  deepseek-v4.1-flash-1017 wrote a well-formed message and never called
  `walkthrough_plan`, 0 of 4 plan turns, and fail from `planned` on. Where a run
  could not settle an observation (no tool call to compare a message with, no
  message recovered), the check is unknown, which a required check counts as a
  failure.

## What it does not cover

Later parts, answers, the wrap-up, and the pane's own rendering. A run stops at
part 1 on a three-file change; a large change reads longer for every model.
