import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  accountNameSchema,
  authenticatedConnectionSchema,
  connectionInputSchema,
  connectionSchema,
} from "./auth-contract.js";
import { resourceSchema } from "./allocations.js";
import { stateSchema } from "./rpc.js";
export const sandboxViewSchema = z
  .object({
    name: z.string(),
    persistent: z.boolean(),
    tags: z.record(z.string(), z.string()).nullable(),
    status: stateSchema,
    sessionId: z.string(),
    sessionStatus: stateSchema,
    expiresAt: z.number().nullable(),
    vcpus: z.number(),
    memory: z.number(),
    image: z.string(),
  })
  .strict();
const operationInput = z
  .object({ connection: connectionSchema, resource: resourceSchema })
  .strict();
export const sessionViewSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    sourceSandboxName: z.string(),
    status: stateSchema,
  })
  .strict();
const result = <S extends z.ZodType>(value: S) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), message: z.string().max(2048) }).strict(),
  ]);
const empty = z.object({}).strict();
export const hostContract = defineRpcContract({
  connect: {
    input: connectionInputSchema,
    output: result(authenticatedConnectionSchema),
  },
  inspect: {
    input: connectionSchema,
    output: result(z.object({ accountName: accountNameSchema }).strict()),
  },
  get: { input: operationInput, output: result(sandboxViewSchema.nullable()) },
  create: { input: operationInput, output: result(sandboxViewSchema) },
  getSession: {
    input: operationInput,
    output: result(sessionViewSchema.nullable()),
  },
  stop: { input: operationInput, output: result(empty) },
  stopSession: { input: operationInput, output: result(empty) },
  delete: { input: operationInput, output: result(empty) },
  exec: {
    input: operationInput
      .extend({
        command: z.array(z.string()).min(1),
        stdin: z.string(),
        timeoutMs: z.number().int().min(1).max(900_000),
      })
      .strict(),
    output: result(
      z
        .object({
          exitCode: z.number().int(),
          output: z.string().max(128 * 1024),
        })
        .strict(),
    ),
  },
});
