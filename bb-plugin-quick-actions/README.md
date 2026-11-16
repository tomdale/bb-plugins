# Quick Actions

Quick Actions puts archive, pin, mark unread, and copy link within reach of the
thread you just finished. Hold Option over a thread, or right-click it, and the
radial menu springs open at the pointer, where the cursor already is. Every
action in the menu is a BB thread action, and you choose which ones it shows,
including actions other plugins register, such as Workstreams' Snooze.

## Trigger

- **Hold Option at the pointer:** the default. Holding Option for 200ms with
  the pointer over a thread's timeline or composer opens a ring of actions
  centred exactly on the cursor, each with its icon and name, with the
  thread's name above it, and dims the window slightly behind it. Over the
  sidebar, the title bar, or the window controls, Option does nothing, so
  Option-clicks there behave as usual. The hub in the middle selects
  nothing; moving the pointer out of it selects the action in that direction,
  shown by a quiet tile and a label that grows slightly. A chevron at an
  action's rim marks a second level: selecting it grows an outer band of
  choices out of its slice (see Choices).
  Releasing Option runs
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
the slices, and the band of choices, that fall outside it.

## Right-click

Right-clicking a thread's timeline opens the same ring at the pointer in place
of the browser's menu, with either trigger. Hold the button, move toward an
action, and release to run it; release in the hub and the ring stays open, so
a click on the disc runs the selection instead. Escape, a press outside the
ring, or typing closes it, and Option does nothing to it.

These places keep the browser's menu: the composer and other fields, links,
images, video, selected text, targets that already have a BB menu (such as
file links and the terminal), and everything outside thread panes. A
context-menu key press keeps it too. Right-clicking a split pane that isn't
focused focuses it first, and the ring opens for that pane's thread.

Turn it off with **Settings → Plugins → Quick Actions → Right-click opens the
menu** or `bb plugin config quick-actions set rightClick false`.

## Settings

Open **Settings → Plugins → Quick Actions** to choose the trigger, the menu
corner and motion, and the ring's actions (see Actions).

- **Menu trigger:** Hold Option at the pointer (default) or Corner button.
- **Right-click opens the menu:** On by default, with either trigger.
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

## Actions

The ring starts with BB's Archive, Pin, Mark read or unread, and Copy link.
Change them under **Settings → Plugins → Quick Actions → Actions**, which
shows the ring as it will open beside its actions in ring order, clockwise
from the top. Each row points the way its action sits in the ring.

- **Add action** lists every BB thread action not yet in the ring, grouped by
  the plugin that registers it: BB's own, then plugins such as Workstreams
  (Snooze), Thread list (Move to section), or Burn (Cost). The ring holds up
  to ten.
- **Drag** a row by its handle, or focus the handle and press the up and down
  arrow keys, to move it. Adding or removing an action respaces the ring, so
  the others turn to new directions.
- **Remove** takes an action out of the ring. The last one stays.
- **Reset to default** brings back BB's four, once you have changed them.

Changes save at once and reach every open BB window. Each action has the name,
icon, and availability BB's own thread menus show for the thread. When a
thread lacks an action, such as Snooze on an archived thread, the action keeps
its slot and shows as unavailable, so the rest point the same way on every
thread; releasing on it shakes the ring and says why. An action whose plugin
is disabled or removed stays in the list marked **Unavailable**, and returns
when its plugin does. Archive keeps BB's child-thread confirmation and Undo.

## Choices

An action with choices, such as Workstreams' Snooze and its presets, carries a
chevron in the hold-Option ring. Moving the pointer a little past the hub onto
it grows a band of its choices out of its slice; slide along the band and
release on one. Every action with choices has its own band, and moving to
another action folds it. The choice the action names as its current value
sits straight out from the action; for Workstreams' Snooze, that is your
default preset. It stays lit while the pointer is on the action, so releasing
there takes it, and so does releasing before the band opens or using the
corner button. A snoozed thread's Snooze names no default, so releasing on it
lets Workstreams decide. BB thread action choices carry only a name, so Snooze
presets show without wake times.

## Checks

From this directory, run `npm ci`, `npm run typecheck`, `npm test`,
`npm run build`, and `../scripts/bb-plugin-smoke "$PWD"`.
