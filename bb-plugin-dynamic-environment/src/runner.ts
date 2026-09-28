import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dynamicEntriesSchema, type DynamicEntry } from "./contract.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export const dynamicEnvironmentEntriesSchema = dynamicEntriesSchema;
export type DynamicEnvironmentEntry = DynamicEntry;

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    timeout?: number;
    windowsHide?: boolean;
  },
) => Promise<ExecFileResult>;

export function parseDynamicEnvironmentEntries(
  value: string,
): DynamicEnvironmentEntry[] {
  return dynamicEnvironmentEntriesSchema.parse(JSON.parse(value));
}

export async function resolveDynamicEnvironmentEntries(
  entries: readonly DynamicEnvironmentEntry[],
  options: {
    execFile?: ExecFileRunner;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<Array<{ name: string; value: string }>> {
  const run: ExecFileRunner =
    options.execFile ?? (execFileAsync as ExecFileRunner);
  const values: Array<{ name: string; value: string }> = [];
  for (const entry of entries) {
    let stdout: string;
    try {
      ({ stdout } = await run("/bin/sh", ["-c", entry.command], {
        env: options.env ?? process.env,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      }));
    } catch {
      throw new Error(`Could not populate ${entry.name}`);
    }
    const value = stdout.trim();
    if (value.length === 0) {
      throw new Error(`Command for ${entry.name} returned an empty value`);
    }
    if (value.includes("\0")) {
      throw new Error(`Command for ${entry.name} returned a NUL byte`);
    }
    values.push({ name: entry.name, value });
  }
  return values;
}
