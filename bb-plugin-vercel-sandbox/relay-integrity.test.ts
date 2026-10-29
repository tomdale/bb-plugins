import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayArtifact } from "./relay-artifact.js";
import { relayLaunchArgs } from "./relay-launch.js";

it("the exact remote launcher refuses changed artifact bytes before importing or reading secret config — local subprocess only", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-integrity-local-"));
  try {
    await writeFile(join(root, "relay.mjs"), `${relayArtifact.source}\nthrow new Error('must-not-execute');`, { mode: 0o600 });
    try {
      await promisify(execFile)(process.execPath, relayLaunchArgs(root), { cwd: root, env: { HOME: root, PATH: process.env.PATH }, timeout: 5000, maxBuffer: 4096 });
      throw new Error("Corrupted artifact unexpectedly accepted");
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Machine relay could not start\n");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
