import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { emptyState, replayCall, type Call, type State } from "./model.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 80;
export type Event = { seq: number; type: string; data: unknown };
const record = (value: unknown): value is Call => !!value && typeof value === "object" && !Array.isArray(value);

export function callFromEvent(event: Event): Call | null {
  if (event.type !== "item/completed" || !record(event.data) || !record(event.data.item)) return null;
  const tool = event.data.item;
  if (tool.type !== "toolCall" || tool.tool !== "todo" || tool.status !== "completed") return null;
  if (typeof tool.error === "string" && tool.error.length > 0) return null;
  if (typeof tool.result === "string" && /^Error:/i.test(tool.result.trimStart())) return null;
  if (record(tool.result) && (tool.result.isError === true || tool.result.error === true)) return null;
  return record(tool.arguments) ? tool.arguments : null;
}

export async function snapshotForThread(bb: BbPluginApi, threadId: string): Promise<State> {
  let state = emptyState();
  let afterSeq: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await bb.sdk.threads.events.list({ threadId, limit: String(PAGE_SIZE), order: "asc", types: ["item/completed"], ...(afterSeq ? { afterSeq } : {}) });
    if (!page.length) return state;
    for (const event of page) {
      const call = callFromEvent(event);
      if (call) state = replayCall(state, call);
    }
    const last = page.at(-1)!;
    if (afterSeq !== undefined && last.seq <= Number(afterSeq)) throw new Error("Todo timeline pagination did not advance");
    afterSeq = String(last.seq);
    if (page.length < PAGE_SIZE) return state;
  }
  throw new Error(`Todo timeline exceeds ${PAGE_SIZE * MAX_PAGES} completed items; refusing a partial snapshot`);
}
