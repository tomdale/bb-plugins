import type { PluginContentScriptRegistration } from "@get-bb/plugin-sdk/app";

/** One root thread's active background subagent count. */
interface ActiveRoot {
  threadId: string;
  working: number;
}

const POLL_INTERVAL_MS = 5000;

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function statusFor(entry: ActiveRoot) {
  return {
    icon: "Bot",
    label: `${entry.working} subagent${plural(entry.working)} running`,
    tone: "running",
  } as const;
}

/**
 * Sidebar thread-row glyph: from any thread in the sidebar, show that a root
 * thread has active subagents. Polls the plugin's own `active-rows` HTTP route
 * (same-origin, so the default "local" auth applies) and mirrors the result
 * into `experimental_setThreadRowStatus`, which older bb clients omit — then
 * this script mounts as a no-op.
 */
export const rowStatusScript: PluginContentScriptRegistration = {
  id: "row-status",
  mount(context) {
    const setStatus = context.experimental_setThreadRowStatus;
    if (!setStatus) return;
    const active = new Set<string>();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const threadId of active) setStatus(threadId, null);
      active.clear();
    };
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/plugins/${context.pluginId}/http/active-rows`, {
          signal: context.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as { roots?: ActiveRoot[] };
        if (stopped || context.signal.aborted) return;
        const seen = new Set<string>();
        for (const entry of Array.isArray(data.roots) ? data.roots : []) {
          if (typeof entry?.threadId !== "string" || !(entry.working > 0)) continue;
          seen.add(entry.threadId);
          setStatus(entry.threadId, statusFor(entry));
          active.add(entry.threadId);
        }
        for (const threadId of active) {
          if (!seen.has(threadId)) {
            setStatus(threadId, null);
            active.delete(threadId);
          }
        }
      } catch {
        // A failed poll keeps the previous statuses; the host clears them on
        // generation deactivation, and `stop` clears them on dispose.
      }
    };
    const timer = setInterval(() => {
      if (!context.signal.aborted) void poll();
    }, POLL_INTERVAL_MS);
    context.signal.addEventListener("abort", stop, { once: true });
    void poll();
    return stop;
  },
};
