# First-paint latency

What the reader waits for between asking and reading, where the time goes, what was
changed, and what is measured. Every number below came from a run on a real model;
what a run did not cover is said beside it.

## Where the time goes

A tool-initiated walkthrough on the deployed build (helper at the thread's own model,
Claude Opus 5.5 at xhigh reasoning, a three-file scratch change), read from
`walkthrough.timing` and the helper's event log (`bb thread log`):

| Stage | Seconds after the ask | What happens |
|---|---:|---|
| Record created | 3.3 to 8.3 | The user's thread decides, calls `walkthrough_open`. The pane tab opens. |
| Fork returned | +0.3 | `threads.fork` returns at once; the workspace provisions afterwards. |
| Helper idle (fork ready) | +2.3 to +7.7 | BB's provisioning. A message queued earlier is **not** delivered: a message sent with `bb thread tell` to a still-provisioning fork reported "queued", and the thread never ran it. So the plan request waits for idle. |
| Plan sent | +0.2 after idle | |
| First helper words | +2.5 to +3.5 after the plan is sent | Reasoning before the opening sentence. |
| Reading | 4 reasoning blocks, 2 to 4 tool rounds | Each round is a reasoning step at xhigh (1.5 to 9 s each) plus the tool. |
| Introduction and part 1 written | the rest | One streamed message, then `walkthrough_plan` and `walkthrough_write_part`. |

The largest single term is the helper's reasoning level, inherited from the user's
thread, and the number of reading rounds. Provisioning and the model's first token are
not ours to shorten.

## What changed

- **The helper runs on its own cheap, fast model.** `HELPER_MODELS` (service.ts) names,
  most preferred first, the models the helper may run on; the first one the user's
  provider serves is sent as `model` with every request to the helper, together with the
  reasoning level (medium when the model lists it). The user's thread keeps its own
  model, and a provider that serves none of the preferences leaves the helper on that
  model. "The helper's model" below has the measurements behind the list.
- **The helper reasons at medium.** `HELPER_REASONING` (service.ts) is sent with every
  request to the helper (`threads.send({ reasoningLevel })`). A model that rejects the
  level gets the request again at its own level. The user's thread is untouched.
- **One round of reading.** The plan instructions ask for a one-sentence opening before
  any tool call or long thinking, then one batch of parallel reads (the diff and at most
  six files), and no second round before part 1 is written.
- **The fork is polled every 150 ms** (was 500 ms) for readiness, and the plan request
  is built from the state re-read after the brief, so the first look at the working tree
  is not overwritten (it used to be lost to a stale save).
- **The pane is alive from the first render.** `walkthrough.detected` records what the
  working tree held at launch (files, staged/unstaged/untracked, +/- lines). While the
  walkthrough is planning the pane shows the request, "In the working tree  3 files · 2
  staged, 1 unstaged · +32 −8", and one live line ("Getting a helper ready…", "Reading
  the code…", "Looking through the code · N steps so far") above the skeleton. First
  words replace it as they stream.

## Measurements

### Before: deployed build, real model, pane sampled every 250 ms

Tool-initiated, scratch repo with three uncommitted files, Opus 5.5 at xhigh, daily BB,
six runs (three with a headless Chrome at 480 px sampling the pane's DOM every 250 ms,
opened as soon as the record existed). Seconds after the ask:

| Run | Record created | Pane ready (DOM) | First words, server | First words, in DOM | Bare skeleton (ready → first words) | Part 1 committed |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 5.0 | – | 10.6 | – | – | 54.6 |
| 2 | 6.5 | – | 12.3 | – | – | 45.2 |
| 3 | 8.3 | – | 18.5 | – | – | 59.6 |
| 4 | 5.7 | 7.7 | 12.6 | 12.7 | 5.0 | 40.1 |
| 5 | 3.3 | 4.5 | 9.6 | 9.7 | 5.2 | 40.5 |
| 6 | 3.4 | 4.8 | 10.6 | 10.8 | 6.0 | 40.4 |
| **median** | **5.4** | 4.8 | **11.5** | 10.8 | **5.2** | **42.9** |

Words reach the DOM within 0.1 s of the server's first text; the reader's wait is the
server's, and the 5 to 6 s between the pane appearing and the first words showed only a
skeleton with no visible line. (Part 1 in the DOM was not sampled: the probe's selector
for a committed figure did not match, so those runs report the server's commit time.)
Three runs on the project's default model (GPT-6 Luna at medium) reached part 1 at 26 to
35 s on the same change.

### After: what could be measured without deploying

The daily BB runs the canonical checkout, and this work is not deployed, so **no
end-to-end run of the new build on a real model exists yet**. Two pieces were measured:

1. **Helper behaviour.** A fork of the same scratch thread (Opus 5.5, xhigh) was sent the
   plan request rendered from the old and the new instruction text
   (`scripts/latency/render-plan-prompt.mjs`), with the walkthrough tools unavailable and
   an instruction to stop after the streamed message. Old text at xhigh versus new text
   at medium, three runs each, seconds after the request was sent:

   | | First helper text | Message finished | Tool rounds |
   |---|---:|---:|---:|
   | old text, xhigh | 8.5, 10.5, 7.4 (mean 8.8) | 51.7, 42.7, 31.3 (mean 41.9) | 4, 2, 2 |
   | new text, medium | 2.6, 2.6, 2.7 (mean 2.6) | 14.8, 14.6, 15.9 (mean 15.1) | 1, 1, 1 |

   Reasoning level alone (same old prompt, three runs each; xhigh 12.6, 10.0, 14.3 s to
   first text and 38.1, 41.4, 43.4 s to finish; medium 5.9, 7.6, 5.1 and 19.5, 24.3, 13.9;
   low 5.7, 9.8, 5.4 and 13.7, 9.8, 13.6) accounts for most of it. The proxy has no plugin
   tools and a tiny change; a larger change reads for longer. Output quality was checked by
   reading one medium run (introduction plus part 1: accurate, specific, in voice), not
   graded.
2. **The waiting pane.** A planning record with `detected` and an in-flight plan request,
   loaded in headless Chrome at 480 and 390 px: the request, the detected summary and the
   live line are in the DOM on the first render, so the bare-skeleton time is 0 s
   (screenshots in /tmp/wt-fix4/ux/n7-waiting-480.png and -390.png). That is a layout
   measurement, not a model run.

Not measured: a starter-initiated walkthrough (it calls the same `service.start`; only
the user's thread being idle differs), the fork of a long thread (the earlier reports'
larger contexts), and the helper's quality at medium across a large change.

### Measure it after deploying

```sh
UAT_PROJECT=<scratch project id> UAT_REPO=<its repo with uncommitted changes> \
BB_SERVER_URL=<the daily server> node scripts/latency/paint.mjs after1
```

spawns a scratch thread asking for a walkthrough, opens the pane page as soon as the
record exists and prints the record time, pane-ready time, first live line, first words
in the DOM and the server's `timing`, for comparison with the table above.
`scripts/latency/fork-experiment.py` repeats the helper experiment (`SOURCE_THREAD`
names the idle thread to fork; `idle-medium@new` and `idle-xhigh@old` need the two prompt
files that `render-plan-prompt.mjs` writes).

## The helper's model

The helper reads a diff and writes prose, so it does not need the frontier model the user
chose for their own thread. `HELPER_MODELS` (service.ts) lists the models it may run on,
most preferred first:

1. `openai/gpt-6-luna`
2. `openai/gpt-5.6-luna`

Catalog ids are provider-scoped (`openai/gpt-6-luna` on one provider,
`vercel-ai-gateway/openai/gpt-6-luna` on another), so a preference matches an id that equals
it or ends with `/` plus it. The walkthrough reads the catalog of the thread's own provider
once (`sdk.providers.models`), takes the first match, and asks for the level that model
lists: medium when it lists medium, else its own default. Every request to the helper
carries both. A provider that serves neither (or a catalog that cannot be read, or a model
the server rejects) leaves the helper on the thread's own model at medium, so a walkthrough
always runs; a rejected model is dropped for the rest of that walkthrough.

### How the list was chosen

Two rounds. First, speed: each candidate was asked for the plugin's real plan turn — the
plan instructions, a working-tree brief, and the note that the `walkthrough_*` tools are
not available — in a hidden thread on a small fixture repo (two source files and a test with
one uncommitted change: a retry cap), at the level above, two runs each. Seconds from the
request, and the output read for format and for claims specific to the fixture:

| Model | First words | Finished | Reasoning blocks (chars) | Tool calls | Read of the output |
|---|---:|---:|---:|---:|---|
| deepseek-v4.1-flash | 2.1, 3.2 | 6.1, 10.9 | 1–2 (70 to 6.0 k) | 4, 5 | Specific and correct: named `DEFAULT_MAX_ATTEMPTS`, `RetryExhaustedError` and the `{ id, value }` results. Marker, `part: 1` fence, code fences and suggestions fence in the right shape both runs. |
| claude-haiku-5.5 (fx lists it; Pi does not) | 3.4, 3.6 | 12.7, 14.3 | 1 (520) | 1, 5 | Specific and in voice ("gives up after a fixed number of attempts instead of retrying forever"), correct format. |
| gpt-6-luna | 3.9, 4.4 | 19.5, 26.1 | 0 | 4, 7 | Specific, correct format, one stray `##` heading inside the part. Also streamed the message in every measured real helper run (below). |
| glm-5.3-flash | 4.9, 6.3 | 20.0, 23.4 | 2–3 (4.1 to 5.5 k) | 5, 5 | Unreliable: one run's final message confirmed a message it had written in an earlier one, the other used `[x](src/retry.ts:28)` links and a `## Part 1:` heading. |
| gemini-3.1-flash-lite | 7.6, 9.0 | 8.1, 9.7 | 2 (1.5 to 1.6 k) | 1, 3 | Fast but generic ("The current changes introduce a robust retry mechanism"), thin on specifics. |
| gemini-3.8-flash | 29.0 (one run) | 57.9 | 2 (7.6 k) | 4 | 48 s of the 58 s was reasoning at medium: the slowest measured. |

Then the one thing that harness cannot show — whether the model calls the plugin's tools at
all. A real walkthrough per model, on a fixture with the same uncommitted change, read from
the record's `timing`:

| Model | Result |
|---|---|
| gpt-6-luna | Planned and wrote: fork 0.2 s, plan sent 3.0 s, first words 15.4 s, `walkthrough_plan` 19.3 s, part 1 ready 20.7 s, part 2 18 s later when the reader moved on. |
| gpt-5.6-luna | Planned and wrote: first words 10.9 s, `walkthrough_plan` 16.6 s, part 1 ready 18.3 s. |
| deepseek-v4.1-flash | Wrote a well-formed introduction and part 1 as its message, then ended the turn without calling `walkthrough_plan`, twice; the walkthrough stayed unplanned. |
| claude-haiku-5.5 | The same, on the path where the fork was replaced by a fresh worker. |

So the fastest models in the first table are the ones that never called the tool, and the
list holds the two that did. Speed on a small change separates them by seconds (18.3 s
against 20.7 s to part 1); reliability does not. For reference, the deployed build on the
user's own model (Opus 5.5 at xhigh) reached part 1 in 42.9 s on a three-file change, so a
pinned helper does about half that on a small one, and it costs a fraction as much.

Not measured: the plugin end to end on a large change, where reading takes longer for any
model, and whether a model that skipped the first round would recover on a second request —
the plugin has no such retry, so a model that ends a plan turn without calling
`walkthrough_plan` leaves the walkthrough unplanned.

### The rule

A model joins `HELPER_MODELS` with both measurements above, not because its name says
"flash" or "mini": the plain-thread harness picks the candidates, and a real walkthrough
confirms the model calls the tools, streams its message, and writes specific prose. A model
leaves when a later measurement is slower or less careful. `openai/gpt-6-luna` covers Pi,
Codex and fx today; `gpt-5.6-luna` is the fallback for a catalog that lists the older model
only.

## Streamed-message compliance

The first words and the early commit of part 1 come from the helper writing its streamed
message (the marker line, then the markup) before calling `walkthrough_plan`. Some helpers
skip it: they call the tools straight away with no content, the tool fails, and the round
is wasted. Earlier real helper runs on the old instructions: 4 of 14 skipped it (Claude
Sonnet 5.5 3 of 3, Opus 5.5 1 of 5).

### Why

The instructions did not differ between helpers that streamed and helpers that did not:
every helper saw the same text, which began "Streaming: the reader sees your chat message
as you write it, in this markup, and the plugin saves what it says. So write each part
once: one message with the whole part, then call walkthrough_write_part with only the
part number, no blocks and no suggestions" and, in the plan turn, "(3) Write one message:
the marker line, then the introduction". The difference is the model. A skipping helper
drafts the part inside its reasoning and then believes it has written it. Sonnet 5.5's
reasoning, from a proxy run, right before its first tool call: "I've documented the retry
loop added to `upload`, showing how it caps attempts at three ...". After the tool error
("There is no walkthrough message earlier in this turn"): "Seems my message needs to be
right before the tool calls rather than earlier in the turn" and then, a round later,
"As a fallback, I should just pass the introduction and blocks explicitly". The skipped
rule was in the middle of long instructions (the requirement came after the explanation),
and the old tool error said only "could not find ... pass blocks yourself".

### Measurements (PROXY, not real helper runs)

Proxy: scratch threads on the real `pi` helper with each model, the plugin's real tools
replaced by a mock that applies the plugin's own commit rules, a small fixture repo, medium
reasoning (`/tmp/uat7/proxy2.py`; the run files were not kept in the repo). Runs shared
the machine, so times are indicative. Plan turn: n = runs that called a walkthrough tool
(runs where the proxy's tool discovery detour ended the turn are left out). "Tool-only"
means the first walkthrough tool call came with no streamed message before it. Real runs
of the new instructions have not been measured: the build is not deployed.

| Model | Instructions | Plan turn, n | Streamed first | Tool-only | Commit on first call | Part 1 committed (median) |
|---|---|---|---|---|---|---|
| Sonnet 5.5 | old | 10 | 0 | 10 | 0 of 10 | 23.9 s |
| Sonnet 5.5 | new (stream) | 5 | 0 | 5 | 0 of 5 | 31.4 s |
| Sonnet 5.5 | new, content in arguments | 10 | n/a | 10 (by design) | 10 of 10 | 10.9 s (px), 20.4 s (pw, loaded machine) |
| Opus 5.5 | old | 9 | 9 | 0 | 9 of 9 | 29.5 s (first words 21 s) |
| Opus 5.5 | new | 8 | 8 | 0 | 8 of 8 | 28 s (first words 15 to 23 s) |
| gpt-6-luna | old | 5 | 5 | 0 | 5 of 5 | 32 s (first words 25 s) |
| gpt-6-luna | new | 4 | 4 | 0 | 4 of 4 | 41 s (first words 33 s, loaded machine) |

Write turns (part 2, helper already planned), same method, Opus 5.5: old 3 streamed, 4
tool-only of 7; new 2 streamed, 5 tool-only of 7. Luna streamed in every write turn (old 3
of 3, new 4 of 4). Sonnet 5.5 old: tool-only in 7 of 7 write turns; with content in
arguments the part committed in 4.9 to 5.5 s on the first call (vs 8.8 to 10.7 s old).

What this says:

- Restructuring the instructions and the richer tool error did **not** change Sonnet 5.5
  (0 of 5 streamed before and after) and did **not** reliably change Opus 5.5 write turns
  (3 of 7 streamed before, 2 of 7 after; too few runs to call it a difference). Opus 5.5
  and Luna plan turns streamed in every run before and after. The nudge cannot be counted
  on to produce a message; in the proxy runs a failed Opus write turn repeated the same
  tool-only call and only then passed arguments.
- A model that does not stream is best served by not asking it to. Sonnet 5.5 told to pass
  the content as arguments commits part 1 on the first call in 10 of 10 plan turns, about
  twice as fast as its old flow (fail, retry with arguments).

### The rule

A part must commit whatever the model does. Streaming is the preferred path (it gives
first words), never the only one: the tools save the message when there is one, a call with
neither a message nor content fails once with the format and an escape hatch (pass the
content as arguments), and content passed as arguments is saved exactly like a message
(same snapshots, suggestions, notes, intent and timing). A per-model policy
(`DELIVERS_IN_ARGUMENTS`) exists only for a model with measured evidence of never
streaming (Sonnet 5.5, 0 of 15 plan turns); a model is added only with such a measurement,
and the policy is removed if a later model streams.

