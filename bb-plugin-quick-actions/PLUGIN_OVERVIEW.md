Quick Actions puts thread actions in a radial menu at the pointer. Holding
Option over a thread pane opens a labelled ring centred on the cursor over a
slight window dim,
and releasing Option runs the action the pointer points toward, so archiving
happens where the hand already is. Releasing in the hub cancels. A
corner trigger remains available as an alternative.

The menu runs BB thread actions: Archive, Pin, Mark read or unread, and Copy
link, plus actions other plugins offer through a `bb-quick-actions:offer`
event on `window`, which Quick Actions requests whenever its menu mounts.
Neither plugin imports the other. With Workstreams installed, its Snooze sits
after Archive, and the hold ring's band lists its presets.

Settings select the trigger, plus the corner trigger's corner and motion, with
an optional debug view of its circular core and radial hit corridors. Changes
apply to open windows without reloading the plugin.
