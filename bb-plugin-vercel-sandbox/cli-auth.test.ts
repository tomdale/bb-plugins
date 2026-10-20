import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cliAuthentication, runVc } from "./cli-auth.js";
import { cliFixture } from "./cli-test-fixture.js";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createVercelHostEntry } from "./host.js";
import { vendorTransport } from "./vendor-test-transport.js";
import { access } from "node:fs/promises";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access) };
});
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(access).mockReset();
  vi.mocked(access).mockRejectedValue(new Error("absent"));
  for (const dispose of disposals.splice(0)) await dispose();
});
async function fixture() {
  const cli = await cliFixture();
  disposals.push(cli.dispose);
  return cli;
}
const signal = () => new AbortController().signal;

describe("CLI authentication boundary", () => {
  it("discovers teams and scoped projects and authenticates explicit IDs without any linked directory", async () => {
    const cli = await fixture();
    await rm(join(cli.directory, ".vercel"), { recursive: true });
    const vendor = vendorTransport();
    const worker = experimental_createHostEntryHarness(
      createVercelHostEntry(vendor.transport, cli.run),
    );
    disposals.push(() => worker.experimental_dispose());
    expect(
      await worker.experimental_call("teams", { hostId: "host_auth" }),
    ).toEqual({
      ok: true,
      value: { choices: [{ id: "team_test", name: "Test team" }] },
    });
    expect(
      await worker.experimental_call("projects", {
        hostId: "host_auth",
        teamId: "team_test",
      }),
    ).toEqual({
      ok: true,
      value: { choices: [{ id: "prj_test", name: "Test project" }] },
    });
    const connected = await worker.experimental_call("connect", {
      hostId: "host_auth",
      ...cli.scope,
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) throw new Error(connected.message);
    expect(connected.value.connection).toEqual({
      hostId: "host_auth",
      directory: null,
      accountId: "user_test",
      ...cli.scope,
    });
    expect(
      await worker.experimental_call("inspect", connected.value.connection),
    ).toMatchObject({ ok: true });
    expect(
      cli.commands.some(
        (args) => args[1] === "/v9/projects?limit=100&teamId=team_test",
      ),
    ).toBe(true);
    expect(
      cli.commands.some((args) => ["link", "login"].includes(args[0]!)),
    ).toBe(false);
    cli.tokenScope = { ...cli.scope, projectId: "prj_other" };
    expect(
      await worker.experimental_call("inspect", connected.value.connection),
    ).toMatchObject({ ok: false });
    cli.tokenScope = cli.scope;
    cli.accountId = "user_other";
    expect(
      await worker.experimental_call("inspect", connected.value.connection),
    ).toMatchObject({ ok: false });
  });

  it("paginates discovery and discards results when the CLI account changes", async () => {
    const cli = await fixture();
    let pages = 0;
    const auth = cliAuthentication(async (args, directory, signal) => {
      if (args[1]?.startsWith("/v2/teams?")) {
        pages++;
        if (pages === 2) {
          expect(args[1]).toContain("until=100");
          return JSON.stringify({
            teams: [{ id: "team_second", name: "Second" }],
            pagination: { next: null },
          });
        }
        return JSON.stringify({
          teams: [{ id: "team_first", name: "First" }],
          pagination: { next: 100 },
        });
      }
      return cli.run(args, directory, signal);
    });
    expect(
      (await auth.teams(signal())).choices.map((choice) => choice.id),
    ).toEqual(["team_first", "team_second"]);
    const changed = cliAuthentication(async (args, directory, signal) => {
      const result = await cli.run(args, directory, signal);
      if (args[1]?.startsWith("/v2/teams?")) cli.accountId = "user_other";
      return result;
    });
    await expect(changed.teams(signal())).rejects.toThrow("account changed");
  });

  it("refreshes project OIDC through noninteractive vc without passing credentials in arguments or allowing implicit SDK refresh", async () => {
    const cli = await fixture();
    const vendor = vendorTransport();
    const worker = experimental_createHostEntryHarness(
      createVercelHostEntry(vendor.transport, cli.run),
    );
    disposals.push(() => worker.experimental_dispose());
    const connected = await worker.experimental_call("connect", {
      hostId: "host_auth",
      directory: cli.directory,
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) throw new Error(connected.message);
    const connection = connected.value.connection;
    expect(await worker.experimental_call("inspect", connection)).toEqual({
      ok: true,
      value: {
        accountName: "fixture-user",
        teamName: "Test team",
        projectName: "Test project",
      },
    });
    expect(cli.tokens.length).toBe(2);
    expect(new Set(cli.tokens).size).toBe(2);
    expect(
      cli.commands.every((args) => args.includes("--non-interactive")),
    ).toBe(true);
    expect(
      cli.commands.every(
        (args) => args[args.indexOf("--api") + 1] === "https://api.vercel.com",
      ),
    ).toBe(true);
    expect(
      cli.commands.some((args) => args[0] === "login" || args[0] === "link"),
    ).toBe(false);
    expect(
      vendor.requests.every(
        (request) =>
          request.url.searchParams.get("teamId") === "team_test" &&
          request.method === "GET",
      ),
    ).toBe(true);
    for (const token of cli.tokens)
      expect(
        JSON.stringify({ connection, commands: cli.commands }),
      ).not.toContain(token);
  });

  it.each([
    "wrong team",
    "wrong project",
    "expired",
    "different account",
    "cancelled login",
  ])(
    "blocks %s without a vendor call or secret-bearing error",
    async (mode) => {
      const cli = await fixture();
      const auth = cliAuthentication(cli.run);
      const { connection } = await auth.connect(
        { hostId: "host_auth", directory: cli.directory },
        signal(),
      );
      if (mode === "wrong team")
        cli.tokenScope = { ...cli.scope, teamId: "team_other" };
      if (mode === "wrong project")
        cli.tokenScope = { ...cli.scope, projectId: "prj_other" };
      if (mode === "expired") cli.expiry = Date.now() - 1;
      if (mode === "different account") cli.accountId = "user_other";
      if (mode === "cancelled login")
        cli.failure = new Error("private-oauth-refresh-token");
      const vendor = vendorTransport();
      const worker = experimental_createHostEntryHarness(
        createVercelHostEntry(vendor.transport, cli.run),
      );
      disposals.push(() => worker.experimental_dispose());
      const result = await worker.experimental_call("inspect", connection);
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain(
        "private-oauth-refresh-token",
      );
      for (const token of cli.tokens)
        expect(JSON.stringify(result)).not.toContain(token);
      expect(vendor.requests).toHaveLength(0);
      expect(
        cli.commands.some((args) => ["login", "link"].includes(args[0]!)),
      ).toBe(false);
    },
  );

  it("checks the CLI version before a directory's first authentication request and once per host process", async () => {
    const cli = await fixture();
    cli.version = "57.9.0";
    const stale = cliAuthentication(cli.run);
    const connection = {
      hostId: "host_auth",
      directory: null,
      accountId: "user_test",
      ...cli.scope,
    };
    await expect(stale.credentials(connection, signal())).rejects.toThrow(
      "Install vc 58.3.0",
    );
    expect(cli.commands).toHaveLength(1);
    expect(cli.tokens).toHaveLength(0);
    cli.version = "58.3.0";
    const auth = cliAuthentication(cli.run);
    await auth.credentials(connection, signal());
    await auth.credentials(connection, signal());
    expect(cli.commands.filter((args) => args[0] === "--version")).toHaveLength(
      2,
    );
    expect(cli.commands.filter((args) => args[1] === "/v2/user")).toHaveLength(
      2,
    );
  });
  it("refuses relinked directories before requesting a token and preserves cancellation across host RPC", async () => {
    const cli = await fixture();
    const auth = cliAuthentication(cli.run);
    const { connection } = await auth.connect(
      { hostId: "host_auth", directory: cli.directory },
      signal(),
    );
    await cli.link({ teamId: "team_test", projectId: "prj_other" });
    await expect(auth.credentials(connection, signal())).rejects.toThrow(
      "linked Vercel project changed",
    );
    expect(cli.tokens).toHaveLength(0);
    const abort = new AbortController();
    const worker = experimental_createHostEntryHarness(
      createVercelHostEntry(vendorTransport().transport, cli.run),
    );
    disposals.push(() => worker.experimental_dispose());
    abort.abort();
    await expect(
      worker.experimental_call("inspect", connection, { signal: abort.signal }),
    ).rejects.toThrow();
    expect(cli.tokens).toHaveLength(0);
  });

  it("consumes vc stdout privately, scrubs credential environment overrides, bounds output, and sanitizes missing CLI failures", async () => {
    const cli = await fixture();
    const bin = join(cli.directory, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "vc"),
      `#!/bin/sh\nif [ -n "$VERCEL_TOKEN$VERCEL_AUTH_TOKEN$VERCEL_OIDC_TOKEN$NODE_OPTIONS$DEBUG_FETCH$FORCE_TTY$AI_AGENT$CURSOR_TRACE_ID$CURSOR_AGENT$CURSOR_EXTENSION_HOST_ROLE$GEMINI_CLI$CODEX_SANDBOX$CODEX_CI$CODEX_THREAD_ID$ANTIGRAVITY_AGENT$AUGMENT_AGENT$OPENCODE_CLIENT$CLAUDECODE$CLAUDE_CODE$CLAUDE_CODE_IS_COWORK$REPL_ID$COPILOT_MODEL$COPILOT_ALLOW_ALL$COPILOT_GITHUB_TOKEN" ]; then echo unsolicited-device-login >&2; exit 1; fi\ncase "$1" in\n  fail) echo private-auth-file >&2; exit 1;;\n  large) head -c 300000 /dev/zero;;\n  hang) trap '' TERM; while :; do :; done;;
  *) printf '{"token":"private-oidc-token"}';;\nesac\n`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", bin);
    for (const key of [
      "VERCEL_TOKEN",
      "VERCEL_AUTH_TOKEN",
      "VERCEL_OIDC_TOKEN",
      "NODE_OPTIONS",
      "DEBUG_FETCH",
      "FORCE_TTY",
      "AI_AGENT",
      "CURSOR_TRACE_ID",
      "CURSOR_AGENT",
      "CURSOR_EXTENSION_HOST_ROLE",
      "GEMINI_CLI",
      "CODEX_SANDBOX",
      "CODEX_CI",
      "CODEX_THREAD_ID",
      "ANTIGRAVITY_AGENT",
      "AUGMENT_AGENT",
      "OPENCODE_CLIENT",
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CLAUDE_CODE_IS_COWORK",
      "REPL_ID",
      "COPILOT_MODEL",
      "COPILOT_ALLOW_ALL",
      "COPILOT_GITHUB_TOKEN",
    ])
      vi.stubEnv(key, "private-override");
    expect(await runVc(["api"], cli.directory, signal())).toBe(
      '{"token":"private-oidc-token"}',
    );
    await expect(runVc(["fail"], cli.directory, signal())).rejects.toThrow(
      "Vercel CLI authentication failed",
    );
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    await expect(runVc(["large"], cli.directory, signal())).rejects.toThrow(
      "Vercel CLI authentication failed",
    );
    const abort = new AbortController();
    const pending = runVc(["hang"], cli.directory, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(pending).rejects.toThrow("Vercel CLI authentication failed");
    vi.stubEnv("PATH", join(cli.directory, "absent"));
    const error = await runVc(["api"], cli.directory, signal()).catch(
      (error: unknown) => error,
    );
    expect(String(error)).toContain("Vercel CLI authentication failed");
    expect(String(error)).not.toContain("private-");
  });
  it("refuses non-environment agent detection before starting the CLI", async () => {
    const cli = await fixture();
    vi.mocked(access).mockResolvedValue(undefined);
    await expect(runVc(["api"], cli.directory, signal())).rejects.toThrow(
      "/opt/.devin agent detection",
    );
  });
});
