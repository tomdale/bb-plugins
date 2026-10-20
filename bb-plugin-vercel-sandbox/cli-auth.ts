import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  accountNameSchema,
  connectionSchema,
  type Connection,
  connectionInputSchema,
} from "./auth-contract.js";
import { SafeError, scopeSchema, type Credentials } from "./configuration.js";

export type CliRunner = (
  args: string[],
  directory: string,
  signal: AbortSignal,
) => Promise<string>;
const CLI_FAILURE =
  "Vercel CLI authentication failed on the selected machine. Install vc 58.3.0 or later, run vc login, and choose a team and project in Settings. Inspection never starts login.";
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
  const choices = async (
    kind: "teams" | "projects",
    teamId: string | undefined,
    signal: AbortSignal,
  ) => {
    const directory = homedir();
    await assertVersion(directory, signal);
    const user = await identity(directory, signal);
    const entries: { id: string; name: string }[] = [];
    let until: number | undefined;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({ limit: "100" });
      if (teamId) query.set("teamId", teamId);
      if (until !== undefined) query.set("until", String(until));
      const endpoint = kind === "teams" ? "/v2/teams" : "/v9/projects";
      const response = JSON.parse(
        await command(
          ["api", `${endpoint}?${query}`, "--raw"],
          directory,
          signal,
        ),
      );
      const item = z.object({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
      });
      const items = z.array(item).max(100).parse(response[kind]);
      const pagination = z
        .object({ next: z.number().int().nonnegative().nullable() })
        .parse(response.pagination);
      entries.push(...items);
      const next = pagination.next;
      if (next === null) {
        if ((await identity(directory, signal)).id !== user.id)
          throw new SafeError(
            "The Vercel CLI account changed while loading choices. Reload the team and project lists.",
          );
        return { choices: entries };
      }
      if (until !== undefined && next >= until) break;
      until = next;
    }
    throw new SafeError(
      "Too many Vercel teams or projects to list. Use the CLI to connect explicit team and project IDs.",
    );
  };
  // Display names are best effort: a failed lookup leaves the IDs shown.
  const names = async (connection: Connection, signal: AbortSignal) => {
    const directory = connection.directory ?? homedir();
    const lookup = async (endpoint: string) => {
      try {
        return z
          .object({ name: z.string().min(1).max(200) })
          .parse(
            JSON.parse(
              await command(["api", endpoint, "--raw"], directory, signal),
            ),
          ).name;
      } catch {
        signal.throwIfAborted();
        return null;
      }
    };
    return {
      teamName: await lookup(`/v2/teams/${connection.teamId}`),
      projectName: await lookup(
        `/v9/projects/${connection.projectId}?teamId=${connection.teamId}`,
      ),
    };
  };
  return {
    names,
    teams: (signal: AbortSignal) => choices("teams", undefined, signal),
    projects: (teamId: string, signal: AbortSignal) =>
      choices("projects", teamId, signal),
    async connect(
      input: z.infer<typeof connectionInputSchema>,
      signal: AbortSignal,
    ) {
      const directory = input.directory ?? homedir();
      await assertVersion(directory, signal);
      const scope =
        input.directory != null
          ? await linkedScope(input.directory)
          : scopeSchema.parse({
              teamId: input.teamId,
              projectId: input.projectId,
            });
      const user = await identity(directory, signal);
      return {
        connection: connectionSchema.parse({
          hostId: input.hostId,
          directory: input.directory ?? null,
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
      const directory = connection.directory ?? homedir();
      await assertVersion(directory, signal);
      const scope =
        connection.directory === null
          ? { teamId: connection.teamId, projectId: connection.projectId }
          : await linkedScope(connection.directory);
      if (
        scope.teamId !== connection.teamId ||
        scope.projectId !== connection.projectId
      )
        throw new SafeError(
          "The linked Vercel project changed. Restore this machine's original linked directory before inspection or cleanup; reconnect for future launches.",
        );
      if ((await identity(directory, signal)).id !== connection.accountId)
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
              directory,
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
      const user = await identity(directory, signal);
      if (user.id !== connection.accountId)
        throw new SafeError(
          "The Vercel CLI account changed during OIDC refresh. Restore the original login and retry.",
        );
      const after =
        connection.directory === null
          ? scope
          : await linkedScope(connection.directory);
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
