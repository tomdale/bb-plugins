# Quick Actions

Quick Actions adds a floating radial menu to open BB threads. Hover or focus
its button to archive, snooze, pin, mark unread, or copy a link to the current
thread. The menu uses BB's native thread actions where they exist.

## Settings

Open **Settings → Plugins → Quick Actions** to choose the menu corner and
motion.

- **Menu corner:** Bottom left (default), Bottom right, Top left, or Top right.
- **Menu motion:** Ring bloom (default) or Arc spring.
- **Debug hover regions:** Off by default. Draws the circular core and radial
  hit corridors without changing pointer behavior.

Inspect or change these values from a terminal:

```sh
bb plugin config quick-actions --json
bb plugin config quick-actions set corner bottom-right
bb plugin config quick-actions set motion arc
bb plugin config quick-actions set debugRegions true
```

Unset a value to restore its default, for example
`bb plugin config quick-actions unset motion`.

## Snooze

Snooze archives the current thread and its active child threads until 9:00 AM
the next day in the BB server's time zone, then returns to New thread. BB asks
for confirmation when active child threads are present. Wake times persist
across BB restarts, and the same threads wake together. Manually unarchiving a
thread cancels its own wake record.

BB's separate Archive action owns its child-thread confirmation and Undo flow.

## Checks

From this directory, run `npm ci`, `npm run typecheck`, `npm test`,
`npm run build`, and `../scripts/bb-plugin-smoke "$PWD"`.
