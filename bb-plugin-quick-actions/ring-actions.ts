/**
 * The ring's actions: BB thread actions the user picked, in ring order,
 * clockwise from the top. Each keeps the title and icon it had when picked,
 * so the ring and the settings list can still name an action whose plugin is
 * gone. Shared by the server, which stores the list, and the app.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The most actions the ring can space around its disc (ring-pie.ts). */
export const RING_ACTION_LIMIT = 10;
/** The realtime channel the server announces a changed list on. */
export const RING_ACTIONS_CHANNEL = "ring-actions";

export type RingAction = { key: string; title: string; icon: string };

/** BB's Archive, Pin, Mark read or unread, and Copy link. */
export const DEFAULT_RING_ACTIONS: readonly RingAction[] = [
  { key: "bb--core/archive", title: "Archive", icon: "Archive" },
  { key: "bb--core/pin", title: "Pin", icon: "Pin" },
  { key: "bb--core/read", title: "Mark read / unread", icon: "MailOpen" },
  { key: "bb--core/copyLink", title: "Copy link", icon: "Copy" },
];

const ringAction = z.object({
  /** A thread action key, `<owner>/<registration id>`. */
  key: z.string().regex(/^[^\s/]+\/[^\s/]+$/),
  title: z.string().min(1).max(120),
  icon: z.string().min(1).max(120),
});

const ringActionList = z
  .array(ringAction)
  .min(1)
  .max(RING_ACTION_LIMIT)
  .refine((actions) => new Set(actions.map((action) => action.key)).size === actions.length, {
    message: "Each action can appear once",
  });

export const rpcContract = defineRpcContract({
  /** The saved list, or null when the user never changed the default. */
  ringActions: {
    input: z.object({}).strict(),
    output: z.object({ actions: z.array(ringAction).nullable() }),
  },
  /** Saves a list; null restores the default. */
  setRingActions: {
    input: z.object({ actions: ringActionList.nullable() }).strict(),
    output: z.object({ actions: z.array(ringAction).nullable() }),
  },
});

/**
 * A stored list as the ring can use it: valid entries only, each key once, at
 * most RING_ACTION_LIMIT. Null when nothing usable is stored.
 */
export function sanitizeRingActions(stored: unknown): RingAction[] | null {
  if (!Array.isArray(stored)) return null;
  const seen = new Set<string>();
  const actions: RingAction[] = [];
  for (const entry of stored) {
    const parsed = ringAction.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.key)) continue;
    seen.add(parsed.data.key);
    actions.push(parsed.data);
    if (actions.length === RING_ACTION_LIMIT) break;
  }
  return actions.length > 0 ? actions : null;
}
