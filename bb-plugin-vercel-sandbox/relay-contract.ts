import { z } from "zod";
import { connectionSchema } from "./auth-contract.js";

export const relayKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const relaySetupSchema = z.object({
  key: relayKeySchema,
  image: z.literal("vercel/sandbox/node:24").default("vercel/sandbox/node:24"),
  authorizedKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}={0,2}$/).max(128),
  bridgePort: z.number().int().min(1024).max(65535).refine(p => p !== 8080 && p !== 38992),
}).strict();
export const relayIdentitySchema = relaySetupSchema.extend({
  owner: z.string().uuid(), generation: z.string().uuid(), connection: connectionSchema,
}).strict();
export type RelayIdentity = z.infer<typeof relayIdentitySchema>;
export const relayViewSchema = z.object({
  key: relayKeySchema, generation: z.string().uuid(),
  name: z.string().regex(/^bb-relay-[a-f0-9]{48}$/),
  hostId: z.string().min(1).max(200), accountId: z.string().min(1).max(200),
  teamId: z.string().max(200), projectId: z.string().max(200),
  phase: z.enum(["prepared", "submitted", "allocated", "launching", "ready", "stopping", "deleting", "removed"]),
  sessionId: z.string().min(1).max(200).nullable(),
  commandId: z.string().min(1).max(200).nullable(),
  origin: z.string().url().max(300).nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().finite().nullable(),
  computeEnded: z.boolean(), metadataDeleted: z.boolean(),
  observedStatus: z.string().max(32),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  image: z.string().max(300),
  vcpus: z.number().int().min(1).max(32).nullable(),
  persistent: z.boolean().nullable(),
  timeoutMs: z.number().int().positive().max(86_400_000).nullable(),
  nodeVersion: z.string().regex(/^v24\.[0-9]+\.[0-9]+$/).max(32).nullable(),
}).strict();
export type RelayView = z.infer<typeof relayViewSchema>;
export const relayReceiptSchema = relayViewSchema.pick({
  key: true, generation: true, name: true, hostId: true, accountId: true, teamId: true, projectId: true,
  fingerprint: true, artifactSha256: true, sessionId: true, origin: true, commandId: true,
});
export type RelayReceipt = z.infer<typeof relayReceiptSchema>;
export function relayReceipt(view: RelayView): RelayReceipt {
  return relayReceiptSchema.parse(Object.fromEntries(Object.keys(relayReceiptSchema.shape).map(key => [key, view[key as keyof RelayView]])));
}
export const relayMethods = {
  "relay.prepare": { input: relaySetupSchema, output: relayViewSchema },
  "relay.inspect": { input: z.object({ key: relayKeySchema }).strict(), output: relayViewSchema.nullable() },
  "relay.stop": { input: z.object({ key: relayKeySchema }).strict(), output: relayViewSchema.nullable() },
};
