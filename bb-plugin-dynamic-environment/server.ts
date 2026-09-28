import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  contract,
  dynamicEntrySchema,
  environmentNameSchema,
} from "./src/contract.js";
import { createDynamicStore } from "./src/dynamic-store.js";
import { createStaticStore } from "./src/static-store.js";
import { resolveDynamicEnvironmentEntries } from "./src/runner.js";

export default async function dynamicEnvironmentPlugin(
  bb: BbPluginApi,
): Promise<void> {
  const dynamic = createDynamicStore(bb.storage.kv);
  const statics = createStaticStore(bb.server.experimental_dataDir);
  for (const providerId of ["codex", "claude-code", "pi"]) {
    bb.providers.experimental_contributeEnv(providerId, async () => {
      const { entries } = await dynamic.list();
      const values = await resolveDynamicEnvironmentEntries(entries);
      return values.map(({ name, value }) => ({
        name,
        value,
        reason: "Dynamic environment command",
      }));
    });
  }
  bb.providers.experimental_contributeEnvHealth("codex", async () => {
    const { entries } = await dynamic.list();
    return {
      label: "Dynamic environment",
      statusMessage:
        entries.length === 0
          ? "No dynamic environment commands configured."
          : `${entries.length} command(s) configured; values resolve when a child environment starts.`,
    };
  });

  bb.rpc.register(contract, {
    dynamicList: () => dynamic.list(),
    dynamicSave: ({ originalName, entry, revision }) =>
      dynamic.save(originalName, entry, revision),
    dynamicRemove: ({ name, revision }) => dynamic.remove(name, revision),
    staticList: () => statics.list(),
    staticSave: ({ originalName, name, value, revision }) =>
      statics.save(originalName, name, value, revision),
    staticRemove: ({ name, revision }) => statics.remove(name, revision),
    reloadConfig: async () => {
      await bb.sdk.system.reloadConfig();
      return { ok: true as const };
    },
  });

  bb.cli.register({
    name: "dynamic-env",
    summary: "Configure dynamic commands and BB env.json variables",
    commands: [
      {
        name: "list",
        summary: "List dynamic variable names and commands",
        usage: "bb dynamic-env list [--json]",
      },
      {
        name: "set",
        summary: "Set a dynamic variable command",
        usage: "bb dynamic-env set <NAME> <COMMAND>",
      },
      {
        name: "remove",
        summary: "Remove a dynamic variable",
        usage: "bb dynamic-env remove <NAME>",
      },
      {
        name: "static-list",
        summary: "List env.json variable names, never values",
        usage: "bb dynamic-env static-list [--json]",
      },
      {
        name: "static-set",
        summary: "Save a static value in env.json (plaintext at rest)",
        usage: "bb dynamic-env static-set <NAME> <VALUE>",
      },
      {
        name: "static-remove",
        summary: "Remove an env.json variable",
        usage: "bb dynamic-env static-remove <NAME>",
      },
      {
        name: "reload",
        summary: "Ask BB to reload its managed configuration",
        usage: "bb dynamic-env reload",
      },
    ],
    async run(argv) {
      try {
        const [command, ...args] = argv;
        if (
          (command === "list" || command === "static-list") &&
          (args.length === 0 || (args.length === 1 && args[0] === "--json"))
        ) {
          const result =
            command === "list"
              ? (await dynamic.list()).entries
              : (await statics.list()).names;
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(result, null, args.length ? undefined : 2)}\n`,
          };
        }
        if (command === "set" && args.length === 2) {
          const entry = dynamicEntrySchema.parse({
            name: args[0],
            command: args[1],
          });
          const state = await dynamic.list();
          await dynamic.save(
            state.entries.some((item) => item.name === entry.name)
              ? entry.name
              : null,
            entry,
            state.revision,
          );
          return { exitCode: 0, stdout: `Configured ${entry.name}.\n` };
        }
        if (command === "remove" && args.length === 1) {
          const name = environmentNameSchema.parse(args[0]);
          await dynamic.remove(name, (await dynamic.list()).revision);
          return { exitCode: 0, stdout: `Removed ${name}.\n` };
        }
        if (command === "static-set" && args.length === 2) {
          const state = await statics.list();
          const input = contract.staticSave.input.parse({
            originalName: state.names.includes(args[0]!) ? args[0] : null,
            name: args[0],
            value: args[1],
            revision: state.revision,
          });
          await statics.save(
            input.originalName,
            input.name,
            input.value,
            input.revision,
          );
          return {
            exitCode: 0,
            stdout: `Saved ${input.name} in env.json. Reload BB configuration; existing processes may need restarting.\n`,
          };
        }
        if (command === "static-remove" && args.length === 1) {
          const name = environmentNameSchema.parse(args[0]);
          await statics.remove(name, (await statics.list()).revision);
          return {
            exitCode: 0,
            stdout: `Removed ${name} from env.json. Existing processes retain their inherited values until restarted.\n`,
          };
        }
        if (command === "reload" && args.length === 0) {
          await bb.sdk.system.reloadConfig();
          return {
            exitCode: 0,
            stdout:
              "BB configuration reloaded. Existing processes may still need restarting.\n",
          };
        }
        return {
          exitCode: 1,
          stderr:
            "Usage: bb dynamic-env <list|set|remove|static-list|static-set|static-remove|reload> [arguments]\n",
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : "Could not update environment configuration."}\n`,
        };
      }
    },
  });
}
