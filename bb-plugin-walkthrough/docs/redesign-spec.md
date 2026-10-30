# Walkthrough redesign: design spec (draft)

Status: decisions from the design grilling. No plugin code changed yet. Open items are listed at the end.

## 1. Principles
- The page is the product: content first, controls float above it and defer to it.
- It should look like a new Apple app made by an indie team: restrained, tactile, one memorable idea (the notebook margin), not a themed kit.
- Perceived speed is a feature: something real is on screen immediately and text streams word by word.

## 2. Look
- **Metaphor:** a notebook page. A ruled left margin carries the part number; notes are marginalia.
- **Type:** elegant serif for prose, headings, captions and marginalia (Newsreader, OFL, bundled, with New York then Georgia fallbacks; verify in BB's Chromium). SF (system-ui) for controls and status. SF Mono (ui-monospace) for code and paths. Weights Regular to Semibold only; no letter-spaced capitals except tiny status labels. Prose 17px/1.6, title 28px, measure 62-68ch.
- **Color:** system neutrals in light and dark (follow BB's mode). One accent, Apple Notes yellow, for highlights, note markers and the current position. Diff uses low-saturation system green and red. No gradients, no glow, no colored borders.
- **Surfaces:** the page is flat, no bordered cards. Separation by whitespace, then a subtle fill shift, then hairlines. Glass (blur + vibrancy) only on the top bar, bottom pager and concerns sheet. No glass on glass.
- **Shape and motion:** concentric radii that nest (window > page > figure > chip). Short spring motion; honors Reduced Motion and Reduced Transparency; no bounce on hover.
- **Copy:** plain verbs, sentence case, no hype.
- **Guideline exception:** this surface is bespoke by decision; add a reading-surface carve-out to `bb-plugin-guidelines` when implementing. Interactive primitives (menus, dialogs, tooltips) still come from the BB registry, restyled.

## 3. Layout
- One part at a time. No left rail.
- **Top bar (glass):** title, part picker ("3 of 5"), Concerns toggle with count, overflow menu (full page, finish, thread).
- **Page:** centered column, 62-68ch. Figures break out to about 900px. Numbered markers sit in the code gutter; the note text hangs in the right margin on wide windows and sits under the figure at panel width (~480px), where everything stacks.
- **Pager (glass, sticky):** Prev, Next (named: "Next: Keeping a failed run"), a question input scoped to the current part, and 2-3 agent-written suggested questions above it.
- **Concerns sheet:** overlay from the right (full width in the narrow panel). The page never reflows. Escape closes and focus returns to the toggle.

## 4. Figures
- The agent picks per figure: current code, or a diff. Diff figures get a Diff / After / Before switch; code figures have none.
- Excerpt text, base and head SHAs are saved when the part is written. Git only refreshes it. A missing workspace shows one muted line and the saved copy, never raw git errors.

## 5. Concerns
- One list: note, todo, comment, ask. Each is anchored to a part and line.
- Select text or a line to flag it. Open items tab and Review draft tab (PR mode). Include in review adds a comment to the draft. Send open items to thread hands todos and questions to the thread agent. Post review shows what will be posted and waits for confirmation.

## 6. Flow
- **Start:** the agent's `walkthrough_open` starts directly. Opening the panel by hand shows a detected-target starter (what was found, one button, optional focus line) and earlier walkthroughs.
- **Pacing:** write one part ahead, then wait for the reader. The part picker shows ready, writing, not started.
- **Questions:** the pager input, scoped to the part or to selected text; answers stream into a margin thread on that part. Suggested questions are written with each part and refreshed after each answer.
- **Finish:** the last part is a wrap-up with a ledger (open items, questions answered, parts skipped) and a primary action by mode: PR review: Post review; own or agent's changes: Send open items to thread; understanding only: Save notes or ask the thread to apply it. Actions are prefilled messages the user confirms. The `.agent/review-notes/` mirror is dropped.

## 7. Performance
- The pane opens at once with a skeleton and the detected target.
- Plan and part 1 are one agent turn; the part list fills the picker as it is planned.
- The worker writes each part as streamed text with ```walkthrough fences. The plugin tails the worker's `item/agentMessage/delta` events at about 100-200ms in a background service, publishes them over plugin realtime, and the client parses fences incrementally into the page. The server's `experimental_thread.events` is debounced to 1/s and is not used for streaming.
- BB's `experimental_codeFenceRenderer` slot (newer SDK than the pinned 0.5.29) would render the same markup inside a real thread; keeping the markup identical keeps that path open. Bump the SDK with feature detection and prototype first, measuring time to first word and frame cadence.
- Log the missing tool-argument streaming in `docs/bb-sdk-wishlist.md`.

## 8. Not yet decided
- Coverage ledger (hunks not covered) and claims with evidence; diff-first versus document model.
- Keyboard model, error and stale states, empty states.
- Whether notes in a non-PR walkthrough sync anywhere besides the thread.
