import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { snapshotForThread } from "./snapshot.ts";

const task = z.object({
  id: z.number().int().positive(), subject: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]),
  description: z.string().optional(), activeForm: z.string().optional(),
  parentId: z.number().int().positive().optional(), blockedBy: z.array(z.number().int().positive()).optional(),
  owner: z.string().optional(),
});
export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    output: z.object({ tasks: z.array(task), nextId: z.number().int().positive() }).strict(),
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, { snapshot: ({ threadId }) => snapshotForThread(bb, threadId) });
  for (const event of ["thread.active", "thread.idle"] as const) {
    bb.events.on(event, ({ thread }) => bb.realtime.publish("todo-timeline-changed", { threadId: thread.id }));
  }
}
