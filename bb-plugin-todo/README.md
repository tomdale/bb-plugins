# BB Todo

A BB-native task list for each thread. The `todo` agent tool owns task state in the plugin database; the composer card and **Todos** thread panel read and edit that state directly. There is no dependency on Pi's Todo extension, tool-call event replay, or a provider-specific state format. New lists start empty; lists from older Pi Todo threads are not imported.

Tasks can be nested with `parentId` and sequenced with `blockedBy`. Creation and updates reject missing, deleted, self-referential and cyclic dependencies or parents. `addBlockedBy` and `removeBlockedBy` edit dependency sets incrementally. Only one task can be in progress; completed tasks cannot reopen and deleted tasks are tombstones. `list` hides tombstones unless `includeDeleted` is true. `clear` empties the list and resets IDs. The Todos panel lets a person edit task fields, dependencies, hierarchy and sibling order; agent and UI changes go through the same reducer.

State belongs to its BB thread and persists across provider sessions and plugin reloads. A thread becoming idle settles unfinished `in_progress` tasks back to `pending`. Deleting a thread removes its task state. The composer card shows progress and unfinished blockers; an all-complete card hides after the configured delay.

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` from this directory. The repository's `scripts/bb-plugin-smoke` checks activation in a throwaway BB server. The daily app loads the plugin from the canonical `main/bb-plugin-todo` path, not a task checkout.
