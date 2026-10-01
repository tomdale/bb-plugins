import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOperation,
  isWithin,
  parseEnvelope,
  resolveCheckout,
  runCommand,
} from "../workforest.js";
import { operationSchema, selector } from "../contracts.js";
import { detail } from "./fixtures.js";

describe("Workforest boundary", () => {
  it("parses successful envelopes and strips unknown data", () => {
    expect(
      parseEnvelope(
        '{"ok":true,"data":{"x":1,"extra":2}}',
        z.object({ x: z.number() }),
      ),
    ).toEqual({ x: 1 });
  });
  it("rejects failed, malformed, and incompatible responses", () => {
    expect(() => parseEnvelope("progress\n{}", z.object({}))).toThrow(
      "non-JSON",
    );
    expect(() =>
      parseEnvelope(
        '{"ok":false,"error":{"message":"not found"}}',
        z.object({}),
      ),
    ).toThrow("not found");
    expect(() =>
      parseEnvelope('{"ok":true,"data":{}}', z.object({ x: z.string() })),
    ).toThrow("Unsupported");
  });
  it.each([
    "--force",
    "../oops",
    "repo/../evil",
    "repo/name;rm",
    "repo/name\n",
    "repo/name/child",
  ])("rejects invalid selector %s", (value) => {
    expect(selector.safeParse(value).success).toBe(false);
  });
  it("creates argv without a shell and preserves configured branch policy", () => {
    expect(
      buildOperation({
        kind: "create",
        name: "fix-auth",
        sources: ["owner/web", "owner/api"],
      }),
    ).toEqual({ args: ["new", "fix-auth", "owner/web", "owner/api"] });
    expect(
      buildOperation({
        kind: "create",
        name: "fix-auth",
        sources: ["@app+api"],
      }).args,
    ).toContain("@app+api");
    expect(() =>
      buildOperation({
        kind: "create",
        name: "fix-auth",
        sources: ["@app", "owner/api"],
      }),
    ).toThrow("not both");
  });
  it("does not accept arbitrary paths, flags, shell input, or destructive commands", () => {
    for (const source of [
      "--force",
      "/tmp/repo",
      "owner/repo;touch /tmp/pwn",
      "$(whoami)",
    ]) {
      expect(
        operationSchema.safeParse({
          kind: "create",
          name: "test",
          sources: [source],
        }).success,
      ).toBe(false);
    }
    expect(
      operationSchema.safeParse({
        kind: "delete",
        selector: detail.selector,
        force: true,
      }).success,
    ).toBe(false);
    expect(
      operationSchema.safeParse({
        kind: "retry",
        selector: detail.selector,
        force: true,
      }).success,
    ).toBe(false);
  });
  it("resolves task cwd only from fresh Workforest metadata", () => {
    expect(
      buildOperation(
        {
          kind: "task",
          selector: detail.selector,
          repository: "app",
          name: "new-tests",
          setup: true,
        },
        detail,
      ),
    ).toEqual({
      args: ["task", "new", "new-tests", "--setup"],
      cwd: detail.path,
    });
    expect(() =>
      buildOperation(
        {
          kind: "task",
          selector: detail.selector,
          repository: "other",
          name: "tests",
          setup: false,
        },
        detail,
      ),
    ).toThrow("not part");
    const dirty = structuredClone(detail);
    dirty.repositories[0]!.dirty.total = 1;
    expect(() =>
      buildOperation(
        {
          kind: "task",
          selector: detail.selector,
          repository: "app",
          name: "tests",
          setup: false,
        },
        dirty,
      ),
    ).toThrow("Commit");
  });
  it("confines checkout paths to fresh Workforest metadata", () => {
    expect(resolveCheckout(detail, detail.tasks[0]!.path)).toBe(
      detail.tasks[0]!.path,
    );
    expect(() => resolveCheckout(detail, `${detail.path}/arbitrary`)).toThrow(
      "no longer part",
    );
  });
  it("matches path segments, not branch names or textual prefixes", () => {
    expect(isWithin("/work/app/_tasks/test", "/work/app")).toBe(true);
    expect(isWithin("/work/application", "/work/app")).toBe(false);
  });
  it("terminates bounded commands on timeout and cancellation", async () => {
    await expect(
      runCommand(["-e", "setInterval(()=>{},1000)"], {
        executable: process.execPath,
        signal: new AbortController().signal,
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out");
    const controller = new AbortController();
    const run = runCommand(["-e", "setInterval(()=>{},1000)"], {
      executable: process.execPath,
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toThrow("cancelled");
  });
  it("bounds command output", async () => {
    await expect(
      runCommand(["-e", "process.stdout.write('x'.repeat(3*1024*1024))"], {
        executable: process.execPath,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("exceeded");
  });
});
