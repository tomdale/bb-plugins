import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRunner } from "./cli-auth.js";
export async function cliFixture() {
  const directory = await mkdtemp(join(tmpdir(), "bb-vercel-cli-test-"));
  await mkdir(join(directory, ".vercel"));
  const scope = { teamId: "team_test", projectId: "prj_test" };
  await writeFile(
    join(directory, ".vercel", "project.json"),
    JSON.stringify({ orgId: scope.teamId, projectId: scope.projectId }),
  );
  const commands: string[][] = [];
  let version = "58.3.0";
  let accountId = "user_test";
  let accountName: string | null = "fixture-user";
  let tokenScope = scope;
  let expiry = Date.now() + 3600_000;
  let failure: Error | null = null;
  const tokens: string[] = [];
  const run: CliRunner = async (args, _directory, signal) => {
    signal.throwIfAborted();
    commands.push(args);
    if (failure) throw failure;
    if (args[0] === "--version") return `${version}\n`;
    if (args[0] !== "api") throw new Error("Unexpected command");
    if (args[1] === "/v2/user")
      return JSON.stringify({
        user: {
          id: accountId,
          username: accountName,
          email: "private-email@example.invalid",
        },
      });
    if (args[1]?.startsWith("/v1/projects/")) {
      const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ owner_id: tokenScope.teamId, project_id: tokenScope.projectId, exp: expiry / 1000, iat: Date.now() / 1000 })).toString("base64url")}.secret-${tokens.length}`;
      tokens.push(token);
      return JSON.stringify({ token });
    }
    throw new Error("Unexpected API request");
  };
  return {
    directory,
    scope,
    commands,
    tokens,
    run,
    set version(value: string) {
      version = value;
    },
    set accountName(value: string | null) {
      accountName = value;
    },
    get accountId() {
      return accountId;
    },
    set accountId(value) {
      accountId = value;
    },
    set tokenScope(value: typeof scope) {
      tokenScope = value;
    },
    set expiry(value: number) {
      expiry = value;
    },
    set failure(value: Error | null) {
      failure = value;
    },
    async link(value: typeof scope) {
      await writeFile(
        join(directory, ".vercel", "project.json"),
        JSON.stringify({ orgId: value.teamId, projectId: value.projectId }),
      );
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
