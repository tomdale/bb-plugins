## Background help, visible when you need it

Give BB agents three small tools to create background subagents, check their progress, and stop stuck work. Workers share the calling thread's environment and inherit its provider and execution permissions.

## Follow the work

Open **Subagents** in a thread's side panel to see live, read-only transcripts, status, and nested runs. Completion sends a bounded result back to the calling agent, and finished worker runtimes are released promptly.

## Take over and hand back

Select **Take control** to promote a run into a normal interactive thread without losing its session or history. The calling agent is notified that the user controls it. **Return control** stops the session and sends its latest output back before returning you to the calling thread.

## Native BB execution

This plugin uses hidden BB threads that reuse the original environment; workers consume normal agent runtime and concurrency resources. Configurable nesting, concurrency and timeout limits keep delegation bounded. Shared files require coordinated edits.

Inspired by [pi-subagent-in-memory](https://github.com/ross-jill-ws/pi-subagent-in-memory).
