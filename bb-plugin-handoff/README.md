# BB Handoff

The `/handoff` slash command for every agent in every project. BB injects the
plugin's `handoff` skill into the provider, so the command works the same in
Codex, Claude Code, Pi, and any other provider.

`/handoff <instructions>` tells the agent to move work into a new BB thread and
says what happens to the thread it leaves behind:

- A **continuation** handoff starts the successor in the current environment, so
  uncommitted edits and the branch carry over untouched.
- Any **other** handoff creates a new Workforest worktree (`wf new <slug>
  <owner/repo> --branch tomdale/<slug>`) and attaches the successor there, so
  the two threads never share a checkout.
- A **delegation** hands a side task away: the source thread keeps its own task
  and asks the user which concrete next steps to take.
- A **takeover** hands the current task away: the source thread commits, pushes
  and merges or opens the PR, removes branches and worktrees nothing else uses,
  then archives itself.

The successor is spawned as a top-level thread at the source thread's provider,
model, and reasoning level, with a prompt that carries the instruction verbatim,
the state of the work, and `@thread:<source>` for its transcript. Files the
successor still reads stay in place.

The server entry registers no routes, tools, or settings; the workflow runs
through the `bb` CLI (`bb thread spawn`, `bb thread show`, `bb thread archive`)
and `wf`.

## Verify

Run `npm ci`, `npm run typecheck`, and `npm run build` from this directory, then
the repository's `scripts/bb-plugin-smoke bb-plugin-handoff` to check activation
in a throwaway BB server. The daily app loads the plugin only from the canonical
`main/bb-plugin-handoff` path.

After installing, `bb skill list` lists `handoff`, and typing `/handoff` in a
thread composer inserts the skill.
