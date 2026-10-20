# BB Todo

A BB-native working plan for each thread. The agent owns it: the `todo` tool is the only way to change plan state, which lives in the plugin database, and the composer card shows it read-only. There is no dependency on Pi's Todo extension, tool-call event replay, or a provider-specific state format. New lists start empty; lists from older Pi Todo threads are not imported.

The `todo` agent tool takes `tasks`, `add`, `under`, `done`, and `start` (`agent.ts`):

- `tasks: string[]` replaces the plan with these subjects, numbered 1..n; the first task starts.
- `add: string[]` appends tasks. On an empty plan it behaves like `tasks`.
- `under: number[]` holds at most one task id and makes the tasks in `add` its subtasks; an unknown id skips the add.
- `done: number[]` completes tasks.
- `start: number[]` marks pending tasks in progress, for parallel or resumed work.

Operations apply in that order. When a call completes a task or adds one and leaves nothing being worked on, the first pending task in display order starts. A parent with unfinished subtasks counts as waiting, so subtasks start in order and the parent completes after them. Unknown ids are reported while the rest of the call applies. A call with no arguments only reads. Every result is the current plan, one line per task (`✓` completed, `▶` in progress, `○` pending), indented under its parent. Models often send `""`, `[]`, `{}` or `null` for fields they do not mean, so blank values count as absent and a bare item is accepted as a one-item list. Fields outside these five are rejected before anything applies. Completed tasks stay completed.

A task has an id, a subject, a status, and an optional parent (`model.ts`). Plans saved by earlier versions keep working: deleted tasks are dropped and unused fields are ignored when a plan is read.

The composer card sits above the prompt, or becomes a gutter lane when the thread's left gutter fits. The lane is vertically centered in the thread beside the conversation, and stays in the gutter even while no message is on screen. It is frameless and always shows the full list (labels wrap), with no count or collapse control. Below the width where the gutter fits, and in queued-message composers, the card stays above the prompt. A card with nothing more to reveal has no count, chevron, or click-to-expand: a one-task plan shows its task row directly, and a plan whose tasks are all in progress shows them all. As a composer banner otherwise, when collapsed, it shows in-progress tasks, 'X of Y todos done' with a progress circle when none are in progress, or 'N todos complete' when all N tasks are complete; clicking anywhere on the collapsed card expands it to the full list. Expanding shows the full list with subtasks grouped under their parent and rendered in 2 balanced columns when the card is wide, with scroll fade gradients when overflowing, and clicking anywhere non-interactive collapses it back.

State belongs to its BB thread and persists across provider sessions and plugin reloads. A thread becoming idle, failed, or archived settles every unfinished `in_progress` task back to `pending`; the next `done` starts the following task, and `start` marks resumed work. Deleting a thread removes its task state. The composer card announces each row's status to screen readers; an all-complete card hides once the plan has gone unchanged for 30 seconds by default (`completedHideDelaySeconds` controls the delay). Each plan is stored with the time it last changed and the snapshot reports its age, so a card opened later hides at once. The finished plan stays stored, and `todo` still reads it, until a later `todo` call changes or replaces it.

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` from this directory. The repository's `scripts/bb-plugin-smoke` checks activation in a throwaway BB server. The daily app loads the plugin from the canonical `main/bb-plugin-todo` path, not a task checkout.
