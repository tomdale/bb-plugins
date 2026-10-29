import { z } from "zod";
import { diagnosticReasons, diagnosticStages, diagnosticStates } from "./diagnostics.ts";
const record = z.object({ generation: z.number().int().min(0).max(65535), stage: z.enum(diagnosticStages), state: z.enum(diagnosticStates), reason: z.enum(diagnosticReasons), httpStatus: z.number().int().min(100).max(599).nullable(), attempts: z.number().int().min(0).max(20) }).strict();
export const diagnosticSnapshotSchema = z.object({ version: z.literal(1), generation: z.number().int().min(0).max(65535), stages: z.array(record).max(diagnosticStages.length), firstFailure: record.nullable() }).strict();
