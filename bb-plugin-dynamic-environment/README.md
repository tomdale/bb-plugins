# Dynamic environment

Manage BB environment variables in **Settings → Dynamic environment** with two
form-based editors:

- **Dynamic variables:** add, edit, rename and remove name/command entries. A
  trusted local command supplies each value when a provider child environment is
  resolved.
- **Static variables:** edit the BB server data directory’s actual `env.json` by
  name and value. Existing values remain server-side; editing a name preserves
  the saved value unless you explicitly choose **Replace saved value**. Removal
  requires confirmation.

No JSON editing, shell startup files or launchd configuration is required.

## Dynamic commands

```sh
bb dynamic-env set AI_GATEWAY_API_KEY "/usr/bin/security find-generic-password -a vercel-ai-gateway -s 'Vercel AI Gateway' -w"
bb dynamic-env list --json
bb dynamic-env remove NAME
```

Commands run on the **BB server**, not on a remote execution host, through
`/bin/sh -c`, with a 10-second timeout and 128 KiB output limit. Trimmed stdout
is contributed to Codex, Claude Code and Pi through
`experimental_contributeEnv`. Resolved values are not logged or persisted by
this plugin. Failed commands, empty output and NUL bytes fail environment
resolution.

Commands are trusted local code running with BB’s permissions. Store retrieval
commands, not literal secrets in command text. Names and commands are persisted
in plugin KV storage and visible in the UI/CLI. Configuration changes apply to
subsequent provider child-environment resolutions, not already-running
processes.

## Static variables (`env.json`)

```sh
bb dynamic-env static-list --json
bb dynamic-env static-set EDITOR vim
bb dynamic-env static-remove EDITOR
bb dynamic-env reload
```

The UI lists variable names but never fetches stored values. New/replacement
values are masked by default and kept only in form state until saving or
cancelling. Leaving **Replace saved value** unchecked preserves the original
value, including during a rename. An explicitly empty replacement saves an empty
string; whitespace is preserved.

Static values are **plaintext at rest** in `env.json`, written atomically with
owner-only permissions. Prefer dynamic commands for Keychain/password-manager
credentials. Use the UI rather than CLI arguments for sensitive values to avoid
shell history/process-argument exposure.

Writes preserve other variables and top-level file fields, use BB’s
`.env.json.lock` advisory lock, and reject stale edits. Invalid files and
symlinks are not overwritten. Revision tokens are keyed and reveal no hash of
stored secrets. If another editor changes the file, cancel the form, reload the
list and reapply the change.

After saving, use **Reload BB configuration** (or `bb dynamic-env reload`).
Processes retain their inherited environment; restarting BB or affected
providers may still be required, particularly when removing a value. This editor
does not change the separate SDK machine-environment store, remote hosts’ files
or macOS launchd settings.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin reload dynamic-environment
```

The plugin uses the public BB SDK for settings slots, typed RPC, command
registration and environment contributions. `fs-native-extensions` is a runtime
dependency for coordinating file writes with BB’s own launcher. Tests exercise
the real SDK harness and filesystem, including conflicting writes, secret
preservation, validation and form interactions.
