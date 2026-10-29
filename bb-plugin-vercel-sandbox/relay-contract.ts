import { z } from "zod";
import { connectionSchema } from "./auth-contract.js";

export const resolvedRelayImageSchema = z.string().length("vercel/sandbox/node@sha256:".length + 64).regex(/^vercel\/sandbox\/node@sha256:[a-f0-9]{64}$/);
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
export const relayAdmissionSnapshotSchema = z.object({
  version: z.literal(1), count: z.number().int().min(0).max(32), suppressed: z.number().int().min(0).max(65535),
  last: z.object({
    reason: z.enum(["route", "http-version", "duplicate-header", "unlisted-header", "header-value", "host-mismatch", "fetch-metadata", "admission", "framing", "artifact-condition", "body-metadata", "upgrade", "connection", "capacity", "policy"]),
    headerNames: z.array(z.string().max(64).regex(/^[a-z][a-z0-9-]*$/).refine(name => name === name.trim())).max(8),
    route: z.enum(["version", "installer", "enrollment", "session", "artifact", "native-ws", "connector", "unlisted"]),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "CONNECT", "OTHER"]),
    status: z.number().int().min(100).max(599).nullable(), hostMatches: z.boolean(),
  }).strict().nullable(),
}).strict();
export const relayCommandObservationSchema = z.object({
  state: z.enum(["unobserved", "not-submitted", "submission-uncertain", "submitted", "pending-or-running", "exited", "unavailable"]),
  exitCode: z.number().int().min(-255).max(255).nullable(), reason: z.enum(["none", "observation-failed", "invalid-exit-code"]),
}).strict();
export const relayAdapterObservationSchema = z.object({ state: z.enum(["unobserved", "available", "missing", "invalid", "unavailable"]), snapshot: relayAdmissionSnapshotSchema.nullable() }).strict();
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
  requestedImage: z.literal("vercel/sandbox/node:24").default("vercel/sandbox/node:24"),
  image: z.string().max(300).nullable(),
  resolvedImage: resolvedRelayImageSchema.nullable().default(null),
  vcpus: z.number().int().min(1).max(32).nullable(),
  persistent: z.boolean().nullable(),
  timeoutMs: z.number().int().positive().max(86_400_000).nullable(),
  nodeVersion: z.string().regex(/^v24\.[0-9]+\.[0-9]+$/).max(32).nullable(),
  commandObservation: relayCommandObservationSchema.default({ state: "unobserved", exitCode: null, reason: "none" }),
  adapterObservation: relayAdapterObservationSchema.default({ state: "unobserved", snapshot: null }),
}).strict();
export type RelayView = z.infer<typeof relayViewSchema>;
export const relayReceiptSchema = relayViewSchema.pick({
  key: true, generation: true, name: true, hostId: true, accountId: true, teamId: true, projectId: true,
  fingerprint: true, artifactSha256: true, sessionId: true, origin: true, commandId: true,
  requestedImage: true, resolvedImage: true,
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
