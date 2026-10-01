# Workforest

Manage isolated development checkouts alongside the agents working in them.

Workforest adds a native BB sidebar destination for searchable worktrees and
multi-repository workspaces, with branch health, setup status, template
creation, and task lanes. A thread-header shortcut and side panel keep the
current checkout's context close to the conversation.

Expose Workforest templates, repositories, and existing checkouts through BB's
native environment picker. BB owns thread creation while Workforest remains the
lifecycle authority; BB does not create a second worktree.

Commands run on the explicitly selected BB machine through host RPC. Mutations
are validated and bounded. Cleanup checks are read-only, and force deletion is
not offered.

Requires Workforest installed on the selected machine and BB 0.42+ / Plugin SDK
0.4.47+.
