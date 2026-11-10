# Quick Actions

Quick Actions puts archive, snooze, pin, mark unread, and copy link within
reach of the thread you just finished. Hold Option and the radial menu springs
open at the pointer, where the cursor already is. The menu uses BB's native
thread actions where they exist.

## Trigger

- **Hold Option at the pointer:** the default. Holding Option for 200ms opens
  a ring of actions centred exactly on the cursor, each with its icon and name,
  and dims the window slightly behind it. The hub in the middle selects
  nothing; moving the pointer out of it selects the action in that direction,
  shown by a quiet tile and a label that grows slightly. Releasing Option runs
  the selection; releasing in the hub cancels, and releasing on an unavailable
  action shakes the ring and says why. Clicking the ring runs the selection
  too. Escape or a press outside the ring cancels. Quick Option-letter accents
  such as ⌥e pass through untouched, and any other keypress removes the ring
  at once so typing is never interrupted; Shift, Command, and Control do not.
  The ring sizes itself to fit its labels, for up to ten actions.
- **Corner button:** the earlier floating trigger, anchored to the composer's
  corner.

Choose between them with **Settings → Plugins → Quick Actions → Menu trigger**
or `bb plugin config quick-actions set trigger corner`.

Near a window edge the pie stays centred on the cursor and the window clips
the slices that fall outside it.

## Settings

Open **Settings → Plugins → Quick Actions** to choose the menu corner and
motion.

- **Menu trigger:** Hold Option at the pointer (default) or Corner button.
- **Menu corner:** Bottom left (default), Bottom right, Top left, or Top right.
  Applies to the corner trigger only.
- **Menu motion:** Ring bloom (default) or Arc spring. Applies to the corner
  trigger only; the hold-Option fan always uses the pie spring.
- **Debug hover regions:** Off by default. Draws the circular core and radial
  hit corridors of the corner trigger without changing pointer behavior.

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
