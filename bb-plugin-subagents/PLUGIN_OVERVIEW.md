## Background help, visible when you need it

Give BB agents three small tools to create background subagents, check their progress, and stop stuck work. Workers share the calling thread's environment and inherit its provider and execution permissions.

## Follow the work

Open **Subagents** in a thread's side panel for a hierarchical Active and Inactive subagent list with live one-sentence status summaries and provider/model/thinking specs, each subagent opening its live, read-only transcript. The thread header carries a live Subagents button while runs work, and a sidebar glyph marks the original thread's row from anywhere in the sidebar. Completion sends a bounded result back to the calling agent, and finished worker runtimes are released promptly.

## Detach into a child thread

Select **Detach subagent** to convert a background worker into a normal interactive child thread of its parent thread without losing its session or history.

## Native BB execution

This plugin uses hidden BB threads that reuse the original environment; workers consume normal agent runtime and concurrency resources. Configurable nesting, concurrency and timeout limits keep delegation bounded. Shared files require coordinated edits.

Inspired by [pi-subagent-in-memory](https://github.com/ross-jill-ws/pi-subagent-in-memory).
