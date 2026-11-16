Quick Actions puts thread actions in a radial menu at the pointer. Holding
Option over a thread pane opens a labelled ring centred on the cursor over a
slight window dim,
and releasing Option runs the action the pointer points toward, so archiving
happens where the hand already is. Releasing in the hub cancels.
Right-clicking a thread pane opens the same ring in place of the browser's
menu, except on fields, links, media, and selected text, which keep theirs. A
corner button can replace the Option hold as the trigger.

The menu runs BB thread actions: Archive, Pin, Mark read or unread, and Copy
link, plus actions other plugins offer through a `bb-quick-actions:offer`
event on `window`, which Quick Actions requests whenever its menu mounts.
Neither plugin imports the other. With Workstreams installed, its Snooze sits
after Archive, and the hold ring's band lists its presets.

Settings select the trigger, turn right-click on or off, and set the corner
trigger's corner and motion, with
an optional debug view of its circular core and radial hit corridors. Changes
apply to open windows without reloading the plugin.
