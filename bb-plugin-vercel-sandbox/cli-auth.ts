import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  accountNameSchema,
  connectionSchema,
  type Connection,
} from "./auth-contract.js";
import { SafeError, scopeSchema, type Credentials } from "./configuration.js";

export type CliRunner = (
  args: string[],
  directory: string,
  signal: AbortSignal,
) => Promise<string>;
const CLI_FAILURE =
  "Vercel CLI authentication failed on the selected machine. Install vc 58.3.0 or later, run vc login, link an existing project with vc link, and reconnect. Inspection never starts login.";
export const runVc: CliRunner = async (args, directory, signal) => {
  signal.throwIfAborted();
  const devin = await access("/opt/.devin").then(
    () => true,
    () => false,
  );
  if (devin)
    throw new SafeError(
      "Vercel CLI authentication cannot run safely on a machine with /opt/.devin agent detection. Choose another enrolled authentication machine.",
    );
  signal.throwIfAborted();
  const env: Record<string, string | undefined> = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    VERCEL_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    NO_UPDATE_NOTIFIER: "1",
  };
  for (const key of Object.keys(env)) {
    if (
      /^(VERCEL_TOKEN|VERCEL_AUTH_TOKEN|VERCEL_OIDC_TOKEN|VERCEL_AUTH_CONFIG_DIR|DEBUG|DEBUG_FETCH|NODE_OPTIONS|NODE_DEBUG|FORCE_TTY|AI_AGENT|CURSOR_TRACE_ID|CURSOR_AGENT|CURSOR_EXTENSION_HOST_ROLE|GEMINI_CLI|CODEX_SANDBOX|CODEX_CI|CODEX_THREAD_ID|ANTIGRAVITY_AGENT|AUGMENT_AGENT|OPENCODE_CLIENT|CLAUDECODE|CLAUDE_CODE|CLAUDE_CODE_IS_COWORK|REPL_ID|COPILOT_MODEL|COPILOT_ALLOW_ALL|COPILOT_GITHUB_TOKEN)$/.test(
        key,
      )
    )
      delete env[key];
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn("vc", args, {
      cwd: directory,
      env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let size = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill("SIGKILL");
      reject(new SafeError(CLI_FAILURE));
    };
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > 256 * 1024) fail();
      else stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      size += data.length;
      if (size > 256 * 1024) fail();
    });
    child.on("error", () => {
      if (signal.aborted) child.kill("SIGKILL");
      signal.removeEventListener("abort", abort);
      reject(new SafeError(CLI_FAILURE));
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failed) return;
      if (code === 0) resolve(stdout);
      else reject(new SafeError(CLI_FAILURE));
    });
  });
};

export function cliAuthentication(run: CliRunner = runVc) {
  const command = (args: string[], directory: string, signal: AbortSignal) =>
    run(
      [
        ...args,
        "--api",
        "https://api.vercel.com",
        "--cwd",
        directory,
        "--non-interactive",
        "--no-color",
      ],
      directory,
      signal,
    );
  const identity = async (directory: string, signal: AbortSignal) =>
    z
      .object({
        user: z.object({
          id: z.string().min(1).max(200),
          username: accountNameSchema.default(null),
        }),
      })
      .parse(
        JSON.parse(
          await command(["api", "/v2/user", "--raw"], directory, signal),
        ),
      ).user;
  const linkedScope = async (directory: string) => {
    try {
      const text = await readFile(
        join(directory, ".vercel", "project.json"),
        "utf8",
      );
      if (text.length > 64 * 1024) throw new Error();
      const linked = z
        .object({
          orgId: scopeSchema.shape.teamId,
          projectId: scopeSchema.shape.projectId,
        })
        .parse(JSON.parse(text));
      return { teamId: linked.orgId, projectId: linked.projectId };
    } catch {
      throw new SafeError(
        "Link an existing Vercel project in the selected directory with vc link before connecting.",
      );
    }
  };
  const assertVersion = async (directory: string, signal: AbortSignal) => {
    const version = await command(["--version"], directory, signal);
    const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.trim());
    if (
      !match ||
      Number(match[1]) < 58 ||
      (Number(match[1]) === 58 && Number(match[2]) < 3)
    )
      throw new SafeError(CLI_FAILURE);
  };
  return {
    async connect(
      input: { hostId: string; directory: string },
      signal: AbortSignal,
    ) {
      await assertVersion(input.directory, signal);
      const scope = await linkedScope(input.directory);
      const user = await identity(input.directory, signal);
      return {
        connection: connectionSchema.parse({
          ...input,
          ...scope,
          accountId: user.id,
        }),
        accountName: user.username,
      };
    },
    async credentials(
      connection: Connection,
      signal: AbortSignal,
    ): Promise<Credentials & { accountName: string | null }> {
      await assertVersion(connection.directory, signal);
      const scope = await linkedScope(connection.directory);
      if (
        scope.teamId !== connection.teamId ||
        scope.projectId !== connection.projectId
      )
        throw new SafeError(
          "The linked Vercel project changed. Restore this machine's original linked directory before inspection or cleanup; reconnect for future launches.",
        );
      if (
        (await identity(connection.directory, signal)).id !==
        connection.accountId
      )
        throw new SafeError(
          "The Vercel CLI account changed. Log in with this allocation's original account before inspection or cleanup; reconnect for future launches.",
        );
      const endpoint = `/v1/projects/${connection.projectId}/token?source=vercel-oidc-refresh&teamId=${connection.teamId}`;
      const response = z
        .object({
          token: z
            .string()
            .min(1)
            .max(32 * 1024),
        })
        .parse(
          JSON.parse(
            await command(
              ["api", endpoint, "--method", "POST", "--raw"],
              connection.directory,
              signal,
            ),
          ),
        );
      const parts = response.token.split(".");
      if (parts.length !== 3)
        throw new SafeError(
          "Vercel returned an invalid project OIDC token. Reconnect after checking project OIDC access.",
        );
      const claims = z
        .object({
          owner_id: z.string(),
          project_id: z.string(),
          exp: z.number().finite(),
        })
        .parse(
          JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
        );
      if (
        claims.owner_id !== connection.teamId ||
        claims.project_id !== connection.projectId ||
        claims.exp * 1000 <= Date.now() + 30_000
      )
        throw new SafeError(
          "Vercel OIDC token scope or expiry does not match the pinned allocation. Reconnect after checking project OIDC access.",
        );
      const user = await identity(connection.directory, signal);
      if (user.id !== connection.accountId)
        throw new SafeError(
          "The Vercel CLI account changed during OIDC refresh. Restore the original login and retry.",
        );
      const after = await linkedScope(connection.directory);
      if (
        after.teamId !== connection.teamId ||
        after.projectId !== connection.projectId
      )
        throw new SafeError(
          "The linked Vercel project changed during OIDC refresh. Restore the original link and retry.",
        );
      signal.throwIfAborted();
      return {
        ...scope,
        token: response.token,
        expiresAt: claims.exp * 1000,
        accountName: user.username,
      };
    },
  };
}
