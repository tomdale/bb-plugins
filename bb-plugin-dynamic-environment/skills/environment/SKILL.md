---
name: environment
description:
  Configure BB dynamic environment commands and static env.json variables using
  this plugin's forms or CLI.
---

Use Settings → Dynamic environment to add, edit, rename or remove variables.

Dynamic commands run trusted shell code on the BB server when a Codex, Claude
Code or Pi child environment is resolved. Store retrieval commands, not secrets
in command text. Output is trimmed, bounded and never logged or persisted by
this plugin. Failure or empty output blocks environment resolution.

- `bb dynamic-env list [--json]`: list names and commands (not resolved values).
- `bb dynamic-env set NAME COMMAND`: add or replace a command.
- `bb dynamic-env remove NAME`: remove a command.

Static variables edit the server data directory's actual `env.json`. Values are
plaintext at rest; prefer dynamic commands for secrets. The UI does not fetch
stored values; leave Replace saved value unchecked to preserve a value when
renaming. Empty string is a valid replacement.

- `bb dynamic-env static-list [--json]`: list names only.
- `bb dynamic-env static-set NAME VALUE`: add or replace a value. Prefer the UI
  for sensitive values to avoid shell history and process arguments.
- `bb dynamic-env static-remove NAME`: delete a variable.
- `bb dynamic-env reload`: ask BB to reload managed configuration. Existing
  processes may retain inherited values until restarted.

No launchd configuration is needed. Editing env.json does not edit the separate
BB machine-environment store or remote machine files. Resolve stale-edit errors
by cancelling the editor, reloading the list and reapplying the intended change.
Do not print secret values during diagnostics.
