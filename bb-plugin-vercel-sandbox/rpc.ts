import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resolvedInputsSchema, vcpusSchema } from "./configuration.js";
import {
  accountInspectionSchema,
  accountConnectInputSchema,
} from "./auth-contract.js";
export const stateSchema = z.enum([
  "pending",
  "running",
  "stopping",
  "stopped",
  "failed",
  "aborted",
  "snapshotting",
  "missing",
]);
export const vercelRpcContract = defineRpcContract({
  "launch.options": {
    input: z.object({}).strict(),
    output: z
      .object({
        image: z.string(),
        defaultInputs: resolvedInputsSchema,
        limits: z
          .object({
            minVcpus: z.number(),
            maxVcpus: z.number(),
            allowedVcpus: z.array(vcpusSchema),
            minTimeoutMinutes: z.number(),
            maxTimeoutMinutes: z.number(),
          })
          .strict(),
        memoryMiBPerVcpu: z.number(),
      })
      .strict(),
  },
  "account.inspect": {
    input: z.object({}).strict(),
    output: accountInspectionSchema,
  },
  "account.connect": {
    input: accountConnectInputSchema,
    output: accountInspectionSchema,
  },
  "machine.inspect": {
    input: z.object({ hostId: z.string().min(1).max(200) }).strict(),
    output: z
      .object({
        summary: z.string(),
        values: z
          .object({
            state: stateSchema,
            computeEnded: z.boolean(),
            sandboxName: z.string(),
            sessionId: z.string().nullable(),
            expiresAt: z.number().nullable(),
            vcpus: z.number(),
            memoryMiB: z.number(),
            image: z.string(),
            teamId: z.string(),
            projectId: z.string(),
          })
          .strict(),
      })
      .strict(),
  },
});
