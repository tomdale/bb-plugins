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
