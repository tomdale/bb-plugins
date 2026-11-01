// What the helper's own event log says a plan turn did: which model ran it, and
// whether the streamed message was written before walkthrough_plan. Both come
// from the log rather than from the prompt a run wrote, because the log is the
// only evidence of what the helper actually did.
import { START_MARKER } from "../../src/stream-markup.ts";
import type { ThreadEvent } from "./bb-cli.ts";

export interface Observations {
  /** The model on the plan request (the first turn the plugin asked for), from the provider's own request event. */
  modelRan: string | null;
  /** Whether a marked-up message was written before walkthrough_plan; null when the helper never called it. */
  streamedMessageBeforeTool: boolean | null;
  /** The marked-up message the helper wrote, for format scoring; null when it wrote none. */
  message: string | null;
}

const isMarked = (text: string | undefined): boolean => typeof text === "string" && text.includes(START_MARKER);

export function observeThread(events: readonly ThreadEvent[]): Observations {
  const planRequest = events.find((event) => event.type === "client/turn/requested" && (event.data?.input?.length ?? 0) > 0);
  const planCall = events.find((event) => event.data?.item?.type === "toolCall" && event.data.item.tool === "walkthrough_plan");
  const messages = events
    .filter((event) => event.data?.item?.type === "agentMessage" && typeof event.data.item.text === "string")
    .map((event) => ({ seq: event.seq, text: event.data!.item!.text! }));
  const marked = messages.filter((message) => isMarked(message.text));
  return {
    modelRan: planRequest?.data?.execution?.model ?? null,
    streamedMessageBeforeTool: planCall === undefined ? null : marked.some((message) => message.seq < planCall.seq),
    message: marked.at(-1)?.text ?? null,
  };
}
