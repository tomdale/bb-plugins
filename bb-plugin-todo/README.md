# BB Todo

A thread-scoped structured todo tool and side panel for BB. Agents use `todo`; people can open **Todos** from the thread panel's new-tab menu. The panel nests tasks by `parentId`, shows unfinished `blockedBy` prerequisites, and offers lifecycle controls. It is a plugin-owned view, **not BB's native pending-todos card**: BB 0.44's native card only accepts flat provider plan steps and has no plugin-write API or hierarchy/dependency/deleted fields.

The tool accepts `create`, `update`, `list`, `get`, and `delete`. `create` starts pending by default and may start in_progress; supply `subject`, optional `description`, `activeForm`, `parentId`, `blockedBy`, `owner`, and `metadata`. `update` accepts mutable fields and additive `addBlockedBy` / `removeBlockedBy` (use `parentId: null` to unparent, `metadata: {"key": null}` to remove a key). `delete` tombstones a task. `list` returns pending and in_progress by default; `includeDeleted: true` returns all statuses, and `status` filters a particular status. IDs are local to each thread and persist across restarts; this is a separate store from Pi Todo and does not import Pi transcript history.

Only one task may be in_progress. Valid transitions: pending → in_progress/completed/deleted; in_progress → pending/completed/deleted; completed → deleted; deleted is terminal. Same-status updates are allowed. A task cannot enter in_progress or completed while any of its blockers are unfinished. Parent/dependency IDs must exist in the same thread and may not form cycles. Deleting a parent or prerequisite keeps the tombstone and references intact. Existing completed work is not retroactively invalidated when a prerequisite is later tombstoned.

For CLI use, run `bb todo run '{"action":"list"}'` from a thread or add `--thread <thread-id>`. The JSON input matches the agent tool fields. The CLI and panel share the same per-thread database. No live BB plugin configuration is changed by building this package.

## Development

Run `npm test`, `npm run typecheck`, and `npm run build` inside this directory. Installation requires an explicit operator decision (`bb plugin install .`), since its tool name can conflict with another installed todo tool.
