# The request record

What each request to the hidden worker ran, how long it took, what it cost in tokens, and
what the reader got. Every walkthrough keeps one row per request it sends, so the questions
this file answers used to need an external harness: which model actually ran the turn, how
long a part takes on a real change, how often a plan turn produces nothing, and what the
walkthrough spent.

Before this record existed the plugin kept nothing of the kind. `timing` holds six marks on
the way to part 1 and nothing after it; `inFlight` is overwritten by the next request; no
model id, token count or price was stored anywhere. The measurements in `docs/latency.md`
were only possible because a scratch probe read BB's own thread log, which the plugin does
not own.

## Where it lives

On the walkthrough's own row (`walkthroughs_v2.data`), as two fields:

- **`requests`** — one row per request, oldest first, capped at 40 (a walkthrough sends one
  per part plus the plan and the wrap-up, and one per question the reader asks, so the cap
  holds a long one whole; past it the oldest rows go, since a measurement is about the
  newest). Absent on walkthroughs written before the record existed.
- **`usage`** — the worker thread's cumulative token counts at the last settled request. A
  row's own tokens are the difference from the reading before it, because that is the only
  form the provider reports.

Neither travels to the pane: `deliver.ts` drops both before the view is built, so a page
open costs no more than it did.

## A row

| field | meaning |
|---|---|
| `n` | 1-based position in this walkthrough's record |
| `kind` | `plan`, `write`, `ask`, `reply`, `wrap-up` |
| `part` | the part a `write` wrote, or the part an `ask` was asked about; **zero-based**, as the request carries it, so the first part is `0`. Null for the plan, a reply, and an ask at the wrap-up |
| `sentAt` / `settledAt` / `ms` | epoch milliseconds when the request went out and when it ended, and the difference, kept so a duration survives a clock adjustment between the two |
| `askedModel` / `askedReasoning` | what the plugin asked for: its `HELPER_MODELS` preference and level, which the server may ignore |
| `model` / `reasoning` | what the turn's own request event names: what actually ran |
| `outcome` | what the reader got: `planned`, `wrote`, `answered`, `replied`, `wrapped-up`, `nudged` (the plan turn wrote its message and called nothing, so a second ask was queued), `empty` (the turn ended with nothing usable), `failed`, `interrupted`, `abandoned` (the walkthrough closed or the plugin restarted while the request was in flight) |
| `turnStatus` | the worker turn's own status from `turn/completed`, such as `completed` or `interrupted` |
| `inputTokens` / `cachedInputTokens` / `outputTokens` | what this request added; `inputTokens` is the uncached part |
| `detail` | a short reason for anything that is not a plain success, with the provider's error code appended when there was one |

A field the plugin could not read stays `null`. The record says what it saw and never fills a
gap with a guess: a provider that emits no `thread/tokenUsage/updated` leaves the token
fields null, and a turn whose request event falls outside the window leaves the model null.

## Reading it

```sh
node --experimental-transform-types --no-warnings scripts/measure-requests.ts
node --experimental-transform-types --no-warnings scripts/measure-requests.ts --db /tmp/copy.db
node --experimental-transform-types --no-warnings scripts/measure-requests.ts --walkthrough wt_abc123
node --experimental-transform-types --no-warnings scripts/measure-requests.ts --json
```

It opens the daily app's database read-only by default (`~/.bb/plugins/walkthrough/data.db`)
and prints duration percentiles, tokens, the model that ran, what was asked for but not run,
and how the requests ended. It needs no model, no network and no BB server.

The same numbers from SQL, if you would rather not run the script:

```sh
sqlite3 ~/.bb/plugins/walkthrough/data.db \
  "select json_extract(r.value,'\$.kind'), count(*), avg(json_extract(r.value,'\$.ms'))
     from walkthroughs_v2 w, json_each(w.data,'\$.requests') r group by 1 order by 2 desc"
```

Each settled request also writes one line to the plugin log (`~/.bb/plugins/walkthrough/logs/plugin.log`):

```
request wt_abc123 #2 write part 1: wrote in 27,412 ms, ran vercel-ai-gateway/openai/gpt-6.1-sol at high (asked for openai/gpt-6-luna), 138,980 in (120,000 cached), 70 out
```

## What it costs

One row appended in the save that already records the request, one extra save when the
request settles (to attach the model and the tokens), and one thread-event read per settled
request — off the critical path, since nothing waits on it before sending the next request.

## What it cannot see

- **Price.** BB reports no cost per turn, so a cost is tokens × a list price you supply, not
  a measured charge. That is also why the `$0.0001` gateway surcharge billed on every call
  does not appear here.
- **Work done outside a request.** Fork provisioning, the working tree reads, and the pane's
  rendering are not requests; `timing` covers the first of those and nothing covers the rest.
- **What the reader did.** No row says whether the reader opened the part, skimmed it, or
  left. The record measures the helper, not the result.
