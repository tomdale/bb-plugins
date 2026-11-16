---
name: quick-actions
description: Configure the Quick Actions BB plugin or explain which actions its ring shows. Use when changing the menu trigger, right-click, corner, or motion, when another plugin should add an action to the ring, or when diagnosing an action missing from it.
---

Read settings with `bb plugin config quick-actions --json`.

Set `trigger` to `hold-option` (hold Option over a thread pane; the default) or `corner` (a button at the composer's corner) with `bb plugin config quick-actions set trigger <value>`. `rightClick` (default `true`, with either trigger) opens the ring when a thread pane is right-clicked, except on fields, links, media, selected text, and targets with their own menu, which keep the browser's menu; set it to `false` to keep the browser's menu everywhere. Set `corner` to `bottom-left`, `bottom-right`, `top-left`, or `top-right`, and `motion` to `ring` (Ring bloom) or `arc` (Arc spring); both apply to the corner trigger only. Set `debugRegions` to `true` to draw the corner trigger's circular core and radial hit corridors, or `false` to hide them. `bb plugin config quick-actions unset <key>` restores a default.

The ring shows BB thread actions: BB's Archive (order 100), Pin (300), Mark read or unread (400), and Copy link (500), plus actions other plugins offer. A plugin offers one of its registered thread actions by dispatching `bb-quick-actions:offer` on `window` with `detail: { key, order? }`, where `key` is `<plugin id>/<registration id>` and an omitted order places it after BB's actions. It dispatches that when it loads and again on every `bb-quick-actions:request`, which Quick Actions sends when its menu mounts. Workstreams offers `workstreams/snooze` at 200. An offered action appears only on threads where BB's own thread menus show it, with the same label, icon, and disabled state. In the hold ring, the first action with choices grows a band of them; the choice whose label equals the action's `detail` is lit, and releasing on the action itself, or running it from the corner menu, takes that choice, or passes no value when no choice matches. The ring holds up to ten actions.

When an offered action is missing, check that its plugin is running (`bb plugin list`) and that BB's thread menu shows the action for that thread. README.md has an example offer under "Extending the menu" and lists the verification commands.
