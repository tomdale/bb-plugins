import { describe, expect, it } from "vitest";
import {
  dynamicEnvironmentEntriesSchema,
  resolveDynamicEnvironmentEntries,
} from "./runner.js";

describe("dynamic environment runner", () => {
  it("never forwards command error text, stdout or stderr containing secrets", async () => {
    await expect(
      resolveDynamicEnvironmentEntries(
        [{ name: "TOKEN", command: "printf ignored" }],
        {
          execFile: async () => {
            throw new Error(
              "Command failed: private-key stdout=secret stderr=secret",
            );
          },
        },
      ),
    ).rejects.toThrow(/^Could not populate TOKEN$/u);
  });
  it("rejects a NUL in resolved output", async () => {
    await expect(
      resolveDynamicEnvironmentEntries(
        [{ name: "TOKEN", command: "ignored" }],
        {
          execFile: async () => ({ stdout: "a\u0000b", stderr: "" }),
        },
      ),
    ).rejects.toThrow("NUL byte");
  });
  it("runs real commands with a bounded timeout", async () => {
    await expect(
      resolveDynamicEnvironmentEntries(
        [{ name: "TOKEN", command: "exec sleep 5" }],
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(/^Could not populate TOKEN$/u);
  });
  it("fails a missing command without leaking shell stderr", async () => {
    await expect(
      resolveDynamicEnvironmentEntries([
        { name: "TOKEN", command: "bb_nonexistent_environment_test_command" },
      ]),
    ).rejects.toThrow(/^Could not populate TOKEN$/u);
  });
  it("validates unique names", () => {
    expect(
      dynamicEnvironmentEntriesSchema.parse([
        { name: "AI_GATEWAY_API_KEY", command: "printf secret" },
      ]),
    ).toEqual([{ name: "AI_GATEWAY_API_KEY", command: "printf secret" }]);
    expect(() =>
      dynamicEnvironmentEntriesSchema.parse([
        { name: "TOKEN", command: "printf a" },
        { name: "TOKEN", command: "printf b" },
      ]),
    ).toThrow(/duplicate/iu);
  });

  it("uses trimmed stdout without logging it", async () => {
    const result = await resolveDynamicEnvironmentEntries(
      [{ name: "TOKEN", command: "printf ignored" }],
      {
        execFile: async () => ({ stdout: " secret-value \n", stderr: "" }),
      },
    );
    expect(result).toEqual([{ name: "TOKEN", value: "secret-value" }]);
  });

  it("fails when a command returns no value", async () => {
    await expect(
      resolveDynamicEnvironmentEntries([{ name: "TOKEN", command: "true" }], {
        execFile: async () => ({ stdout: "\n", stderr: "" }),
      }),
    ).rejects.toThrow(/empty value/u);
  });
});
