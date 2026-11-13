---
name: quick-actions
description: Configure the Quick Actions BB plugin or investigate its thread snooze lifecycle. Use when changing the menu corner or motion, explaining snooze timing, or diagnosing a thread that did not wake.
---

Read settings with `bb plugin config quick-actions --json`.

Set `corner` with `bb plugin config quick-actions set corner <value>`, where `<value>` is `bottom-left`, `bottom-right`, `top-left`, or `top-right`. Set `motion` with `bb plugin config quick-actions set motion ring` for Ring bloom or `bb plugin config quick-actions set motion arc` for Arc spring. Use `bb plugin config quick-actions unset <key>` to restore a default. Set `debugRegions` to `true` to draw the circular core and radial hit corridors, or to `false` to hide them.

Snooze archives the current thread and its active descendants until a wake time. In the hold-Option ring, moving past Snooze's label opens a band of presets in the viewer's time zone: In 1 hour; This evening, 6:00 PM, offered before 5:00 PM; Tomorrow, 9:00 AM, the default; This weekend, Saturday 9:00 AM, offered Monday to Thursday; Next week, Monday 9:00 AM, unless that is tomorrow. The corner button, and releasing on Snooze before the band opens, wake at 9:00 AM the next day in the BB server's time zone. The `snooze` RPC takes an optional `wakeAt` in epoch ms and refuses one in the past or more than a year out. BB asks for confirmation when active descendants are present. The plugin stores one wake generation per thread and checks due records on startup and once per minute. Manually unarchiving a thread cancels its own wake record. Missing threads are removed during wake reconciliation. BB's separate Archive action handles its own child confirmation and Undo.

Check `bb plugin list` for the `snooze-wake` schedule and `bb plugin logs quick-actions` for wake failures. Source and verification commands are in the plugin's `README.md`.
