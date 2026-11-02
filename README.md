# bb-plugins

Plugins for [BB](https://github.com/get-bb/bb), one per `bb-plugin-*` directory.
Each is a standalone package; see its README for what it does and how to
configure it.

| Plugin                                               | What it does                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| [Dynamic environment](bb-plugin-dynamic-environment) | Manage command-backed variables and BB's static `env.json` with forms |
| [Handoff](bb-plugin-handoff)                         | Hand work off to a new thread, in its own worktree for new work       |
| [Sidebar Switcher](bb-plugin-sidebar-switcher)       | Switch which plugin renders BB's sidebar thread list                  |
| [Subagents](bb-plugin-subagents)                     | Background subagents with live transcripts and user takeover          |
| [Thread Export](bb-plugin-thread-export)             | Save a thread as a standalone HTML page that looks like bb            |
| [Todo](bb-plugin-todo)                               | Show the agent's per-thread todo plan in the composer                 |
| [Read aloud](bb-plugin-tts)                          | Play spoken audio for an assistant response                           |
| [Walkthrough](bb-plugin-walkthrough)                 | Walk through a changeset one conceptual group at a time               |
| [Workforest](bb-plugin-workforest)                   | Workforest workspaces, task lanes, and BB threads in one place        |

The Vercel Sandbox plugin is maintained in a private repository.

## Install a plugin

```sh
git clone https://github.com/tomdale/bb-plugins.git
cd bb-plugins/bb-plugin-<name>
npm ci
npm run build
bb plugin install "$PWD" --yes
```

Path installs load from that directory, so keep the checkout in place while the
plugin is installed. `scripts/bb-plugin-smoke <plugin-dir>` checks that a built
plugin activates in a throwaway BB server without touching your own.
