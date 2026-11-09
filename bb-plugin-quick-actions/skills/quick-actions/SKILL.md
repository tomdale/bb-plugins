---
name: quick-actions
description: Configure the Quick Actions BB plugin or investigate its thread snooze lifecycle. Use when changing the menu corner or motion, explaining snooze timing, or diagnosing a thread that did not wake.
---

Read settings with `bb plugin config quick-actions --json`.

Set `corner` with `bb plugin config quick-actions set corner <value>`, where `<value>` is `bottom-left`, `bottom-right`, `top-left`, or `top-right`. Set `motion` with `bb plugin config quick-actions set motion ring` for Ring bloom or `bb plugin config quick-actions set motion arc` for Arc spring. Use `bb plugin config quick-actions unset <key>` to restore a default.

Snooze archives the current thread and its active descendants until 9:00 AM the next day in the BB server's time zone. BB asks for confirmation when active descendants are present. The plugin stores one wake generation per thread and checks due records on startup and once per minute. Manually unarchiving a thread cancels its own wake record. Missing threads are removed during wake reconciliation. BB's separate Archive action handles its own child confirmation and Undo.

Check `bb plugin list` for the `snooze-wake` schedule and `bb plugin logs quick-actions` for wake failures. Source and verification commands are in the plugin's `README.md`.
