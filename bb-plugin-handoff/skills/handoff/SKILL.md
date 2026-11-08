---
name: handoff
description:
  Hand work off to a new BB thread, in its own Workforest worktree for new work
  or in this thread's environment when it continues the work in progress, then
  either stay on this thread's own task or publish, clean up, and archive this
  thread. Use when a message contains `$handoff` or `/handoff`, when asked to
  hand off, to move work into a new thread, to clear this thread while the work
  continues elsewhere, or to delegate a side task.
---

# Hand off to a new thread

Text after `/handoff` is the handoff instruction. `bb` reads this thread and
project from `BB_THREAD_ID`, `BB_PROJECT_ID`, and `BB_ENVIRONMENT_ID`.

## 1. Scope and classify the handoff

The instruction names work. List its work items and give each an owner: the
successor, or this thread.

The phrase that hands work off — "hand off this task", "`$handoff <task>`" —
owns the item it introduces: everything after the phrase, up to the next
instruction or the end of the message, whether that is one sentence, a list, or
a block of settings. "This task" and "the task below" name that introduced
item, not the rest of the message.

Sequencing words around the phrase name the items that stay: "before beginning",
"first … then", "while I …", "after that". Work the message asks for anywhere
else stays here.

Ask the user which items move when the phrase introduces no item, or when the
message draws no clear boundary between the item it introduces and work that
stays. State the split in one line before spawning: `<item> → successor; <item>
→ this thread`.

Continuation: the successor carries on the work in progress here. It attaches
to this environment with `--environment "$BB_ENVIRONMENT_ID"`, so uncommitted
edits, the branch, and background state stay exactly where they are.

Independent: the successor owns a separate task. It gets a fresh Workforest
worktree and leaves this checkout alone.

Ask which one the user means when the instruction could be either.

Ownership follows the moving item. A takeover moves the work this thread was
chartered to do; a delegation moves tangential work while this thread keeps its
primary task. Ask the user when the split does not settle it.

## 2. Spawn the successor

Spawn a top-level thread: no `--parent-self`, no `--parent-thread`, no
`--lifecycle-owner-thread`. The successor outlives this thread's archive and
reports to the user.

Match this thread's model so the successor runs as this one is running:

```sh
bb thread show --self --json | jq -r .thread.providerId
bb thread log --self --json --all | jq -r '[.. | objects | select(has("execution")) | .execution] | last | [.model, .reasoningLevel] | @tsv'
```

Leave `--permission-mode` out; BB resolves one the provider accepts (Pi runs
only in `full`).

An independent handoff creates its workspace first, for the repository in
`git remote get-url origin` (`git@github.com:tomdale/bb-plugins.git` is
`tomdale/bb-plugins`). Worktree initialization continues in the background, so
the next command can run as soon as `wf new` returns:

```sh
wf new <slug> <owner/repo> --branch tomdale/<slug>
path=$(wf status <repo-name>/<slug> --json | jq -r .data.path)
```

Workforest owns that worktree and its branch. It starts at the repository's
committed HEAD, so commit or push anything the successor must read there.
`<repo-name>` is the repository without its owner (`tomdale/bb-plugins` is
`bb-plugins`). Its `wf delete <repo-name>/<slug>` later removes the worktree and
keeps the branch and cached mirror; it refuses a dirty or unmerged worktree.

Write the prompt to a file and pass `--prompt-file`, which keeps backticks and
`$` literal:

```sh
# continuation: this thread's environment
env=$BB_ENVIRONMENT_ID
# independent: the Workforest worktree from `wf new`
env=$(wf status <repo-name>/<slug> --json | jq -r .data.path)

bb thread spawn --project "$BB_PROJECT_ID" --environment "$env" \
  --title "<title>" --provider <id> --model <id> --reasoning-level <level> \
  --prompt-file handoff-prompt.md --json
```

The successor starts with no conversation history, so the prompt carries:

- `@thread:<this thread ID>`, with one line on what its transcript holds
- the user's handoff instruction verbatim, keeping the phrase that marks the
  moving item
- the task: goal, done criteria, what is finished, what remains, decisions
  already made
- the items that stay here, so the successor leaves them alone
- the state to build on: workspace path, branch, commits, PR, files it will
  edit, the verification run and its result
- ownership: a takeover successor owns the work this thread was chartered to do
  and its publish; a delegated successor owns its own item and reports to the
  user
- the paths and resources it must leave alone

Confirm the successor started: `bb thread show <id>` reports `starting` or
`active` with the prompt delivered, and `bb thread open <id>` brings it up for
the user. If the spawn fails, report the failure and keep the work here.

## 3. Finish this thread's part

Delegation, a tangential task that frees this thread to focus on its primary
task: leave this thread open. Tell the user the primary task stays here and
propose resuming it with the next concrete step. If several next steps are
reasonable, ask which one to take, then begin the chosen step.

Takeover, where the successor owns the work this thread was chartered to do:
list the major tasks this thread still owns — the split's items that stay here
and any planned work the instruction never named. If none remain, make this
thread's share durable, then archive it. If any remain or their ownership is
unclear, leave this thread open and ask the user whether the successor should
take them or this thread should resume them. Archive only when all major work
has an owner and this thread has none.

For a takeover with no remaining major work, finish these steps before
archiving:

1. Commit completed work on the current branch. A bb-managed worktree deletes
   its directory, uncommitted files, and untracked files five minutes after its
   last thread is archived, and keeps only the branch.
2. Push it and merge or open the PR under the repository's rules, including a
   repository skill that owns publish and cleanup. A successor in its own
   worktree starts from origin, not from this disk.
3. Remove only what nothing else uses: merged local branches, finished task
   worktrees, temporary files, environments whose threads are gone. A finished
   Workforest worktree closes with `wf delete <repo-name>/<slug>`, which keeps
   the branch and cached mirror and refuses dirty or unmerged work.
4. Run `bb thread archive --self`. Complete any confirmation BB presents; if
   the user cancels, keep this thread open.

Never delete or move what the successor relies on. A continuation successor
shares this workspace, so its files, branch, untracked files, and environment
stay. A separate successor still reads files this thread created, such as
transcripts, plans, drafts, and generated artifacts, so carry what it needs
into the prompt or a tracked file before removing the original. Secrets stay
out of both, since a prompt is read by later readers and a tracked file is
committed.

Ask the user before deleting a worktree or branch that holds unmerged commits,
which would lose work that exists nowhere else.
