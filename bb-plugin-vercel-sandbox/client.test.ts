import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createVercelClient, sandboxExecutor } from "./client.js";
import { vendorTransport } from "./vendor-test-transport.js";

async function execFixture(
  options: { abort?: AbortController; failExec?: boolean } = {},
) {
  const vendor = vendorTransport();
  const uploads: Buffer[] = [];
  const commands: Record<string, unknown>[] = [];
  const kills: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const command = {
    id: "cmd-1",
    name: "sh",
    args: [],
    cwd: "/vercel",
    sessionId: "session-1",
    exitCode: null,
    startedAt: 100,
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    init?.signal?.throwIfAborted();
    if (!url.pathname.includes("/sessions/"))
      return vendor.transport(input, init);
    if (init?.signal) signals.push(init.signal);
    if (url.pathname.endsWith("/fs/write")) {
      if (!(init?.body instanceof Uint8Array))
        throw new Error("Expected gzip upload");
      uploads.push(Buffer.from(init.body));
      return json({});
    }
    if (url.pathname.endsWith("/cmd") && init?.method === "POST") {
      const body = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(String(init.body)));
      commands.push(body);
      if (body.wait) {
        return new Response(
          `${JSON.stringify({ command })}\n${JSON.stringify({ command: { ...command, exitCode: 0 } })}\n`,
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      if (options.failExec)
        return new Response(
          JSON.stringify({
            error: { code: "internal", message: "private-stdin" },
          }),
          { status: 503 },
        );
      return json({ command });
    }
    if (url.pathname.endsWith("/kill")) {
      kills.push(
        z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body))),
      );
      return json({ command });
    }
    if (url.pathname.endsWith("/logs")) {
      return new Response(
        `${JSON.stringify({ stream: "stdout", data: "x".repeat(150 * 1024) })}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    if (url.pathname.endsWith("/cmd/cmd-1")) {
      options.abort?.abort();
      init?.signal?.throwIfAborted();
      return json({ command: { ...command, exitCode: 0 } });
    }
    throw new Error(`Unexpected vendor execution path ${url.pathname}`);
  };
  const settings = {
    token: "secret-token",
    expiresAt: Date.now() + 3600_000,
    teamId: "team_test",
    projectId: "prj_test",
  };
  const sandbox = await createVercelClient(
    settings,
    transport,
    async () => settings,
  ).create(
    "bb-exec-test",
    {},
    { vcpus: 2, timeoutMinutes: 30 },
    new AbortController().signal,
  );
  return {
    executor: sandboxExecutor(sandbox),
    commands,
    kills,
    uploads,
    signals,
  };
}

describe("Vercel bootstrap executor", () => {
  it("keeps stdin out of arguments, uploads it privately, bounds streaming output, and passes a vendor command deadline", async () => {
    const test = await execFixture();
    const output: string[] = [];
    expect(
      await test.executor.exec({
        command: ["sh", "-s", "--", "--start"],
        stdin: "private-stdin",
        timeoutMs: 12_345,
        signal: new AbortController().signal,
        onOutput: (chunk) => output.push(chunk),
      }),
    ).toEqual({ exitCode: 0 });
    const archive = gunzipSync(test.uploads[0]!);
    expect(
      parseInt(archive.subarray(100, 108).toString().replace(/\0/g, ""), 8),
    ).toBe(0o600);
    expect(archive.subarray(512, 525).toString()).toBe("private-stdin");
    expect(JSON.stringify(test.commands)).not.toContain("private-stdin");
    expect(test.commands[0]).toMatchObject({ command: "sh", timeout: 12_345 });
    expect(test.commands[0]?.args).toContain(
      'set -eu; exec 3<"$1"; rm -f -- "$1"; shift; exec "$@" <&3',
    );
    expect(output.join("")).toHaveLength(128 * 1024);
    expect(test.signals.every((signal) => signal instanceof AbortSignal)).toBe(
      true,
    );
  });

  it("attempts SIGKILL on cancellation after a command receipt and cleans the temporary input", async () => {
    const abort = new AbortController();
    const test = await execFixture({ abort });
    await expect(
      test.executor.exec({
        command: ["sleep", "120"],
        stdin: "private-stdin",
        timeoutMs: 1000,
        signal: abort.signal,
        onOutput() {},
      }),
    ).rejects.toThrow();
    expect(test.kills).toEqual([{ signal: 9 }]);
    expect(test.commands.at(-1)).toMatchObject({
      command: "rm",
      timeout: 10_000,
    });
  });

  it("submits exec once on an uncertain server response and emits a secret-free failure", async () => {
    const test = await execFixture({ failExec: true });
    await expect(
      test.executor.exec({
        command: ["sh", "-s"],
        stdin: "private-stdin",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onOutput() {},
      }),
    ).rejects.toThrow("execution failed");
    expect(
      test.commands.filter((command) => command.command === "sh"),
    ).toHaveLength(1);
    expect(test.kills).toHaveLength(0);
    expect(test.commands.at(-1)?.command).toBe("rm");
  });
});

describe("host-owned OIDC transport", () => {
  it("refreshes expiring OIDC privately and refuses a refreshed foreign scope before sending a mutation", async () => {
    const vendor = vendorTransport();
    const settings = {
      token: "old-private-oidc",
      expiresAt: 0,
      teamId: "team_test",
      projectId: "prj_test",
    };
    const headers: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      headers.push(new Headers(init?.headers).get("authorization")!);
      return vendor.transport(input, init);
    };
    let refreshes = 0;
    const client = createVercelClient(settings, transport, async () => {
      refreshes++;
      return {
        ...settings,
        token: "fresh-private-oidc",
        expiresAt: Date.now() + 3600_000,
      };
    });
    await client.inspectAccount(new AbortController().signal);
    expect(refreshes).toBe(1);
    expect(headers).toEqual(["Bearer fresh-private-oidc"]);
    const foreign = createVercelClient(settings, transport, async () => ({
      ...settings,
      teamId: "team_other",
      expiresAt: Date.now() + 3600_000,
    }));
    await expect(
      foreign.create(
        "bb-foreign",
        {},
        { vcpus: 2, timeoutMinutes: 30 },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(vendor.allocationCount).toBe(0);
    expect(headers).toHaveLength(1);
  });
});
