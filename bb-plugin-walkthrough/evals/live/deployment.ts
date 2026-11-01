// What the running BB app has deployed, and whether it can run the model a live
// run is about to measure.
//
// A live run measures the helper model the deployed build sends, and nothing
// outside the build chooses that model: HELPER_MODELS in service.ts is read at
// request time, and the built bundle renames it. So the deployed preferences are
// read from the plugin's source (a path-installed plugin is deployed from the
// checkout the app serves), the built bundle is checked to contain every one of
// them (a bundle that does not is a stale build, not a pin), and then the run
// refuses up front when the deployed build cannot pin the model under test
// rather than spending model turns on a measurement of some other model.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pickHelperModel, type CatalogModel } from "../../src/service.ts";
import { installedPlugin } from "./bb-cli.ts";

export class PreflightRefusal extends Error {}

export interface DeployedPlugin {
  id: string;
  root: string;
  helperModels: string[];
  /** The source the preference list was read from. */
  readFrom: string;
  /** The built bundle the preferences were found in, or null when the plugin has no build yet. */
  build: string | null;
}

const PLUGIN_ID = "walkthrough";
const SOURCE = "src/service.ts";
/** `bb plugin build` output, as the server loads it. */
const BUILDS = ["dist/server.js", "dist/bb.server/server.js"];
const DECLARATION = /HELPER_MODELS\s*(?::[^=]{0,80})?=\s*\[([^\]]*)\]/u;

export function deployedWalkthroughPlugin(): DeployedPlugin {
  const plugin = installedPlugin(PLUGIN_ID);
  if (plugin === null) throw new PreflightRefusal(`no installed "${PLUGIN_ID}" plugin: the live layer measures a deployed walkthrough`);
  const source = join(plugin.rootDir, SOURCE);
  if (!existsSync(source)) {
    throw new PreflightRefusal(
      `cannot read the deployed helper models: ${source} does not exist, and a built bundle renames HELPER_MODELS, so a run could not confirm which model it measured`,
    );
  }
  const found = DECLARATION.exec(readFileSync(source, "utf8"));
  const helperModels = found === null ? [] : [...found[1]!.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]!);
  if (helperModels.length === 0) throw new PreflightRefusal(`no HELPER_MODELS list in ${source}, so a run could not confirm which model it measured`);

  const build = BUILDS.map((relative) => join(plugin.rootDir, relative)).find((file) => existsSync(file)) ?? null;
  if (build !== null) {
    const bundle = readFileSync(build, "utf8");
    const missing = helperModels.filter((model) => !bundle.includes(model));
    if (missing.length > 0) {
      throw new PreflightRefusal(
        `the deployed build at ${build} does not contain ${missing.join(", ")}, which ${source} pins: the build is older than the source. Rebuild (npm run build) and reload (bb plugin reload ${PLUGIN_ID}) before a live run, or every run would measure the model the old bundle sends.`,
      );
    }
  }
  return { id: plugin.id, root: plugin.rootDir, helperModels, readFrom: source, build };
}

/** The catalog id a preference names, without the provider prefix. */
function bareModel(catalogId: string): string {
  return catalogId.slice(catalogId.indexOf("/") + 1);
}

/**
 * Refuses unless the deployed build pins exactly `model` for `providerId`: the
 * first preference the provider lists has to be that model, because the plugin
 * sends the first match.
 */
export function requireMeasurable(model: string, providerId: string, catalog: readonly CatalogModel[], deployed: DeployedPlugin): void {
  if (!catalog.some((entry) => entry.id === model)) {
    throw new PreflightRefusal(`${model} is not in the ${providerId} provider catalog, so it cannot be measured (bb provider models ${providerId} --json)`);
  }
  const chosen = pickHelperModel(catalog, deployed.helperModels);
  if (chosen?.model === model) return;
  const remediation = [
    `pin it in the canonical checkout for the duration of the run:`,
    `  1. in ${deployed.readFrom} put "${bareModel(model)}" first in HELPER_MODELS`,
    `  2. cd ${deployed.root} && npm run build`,
    `  3. bb plugin reload ${PLUGIN_ID}`,
    `then restore HELPER_MODELS afterwards, and rebuild and reload again.`,
  ].join("\n");
  throw new PreflightRefusal(
    [
      `refusing to run: ${model} is not the helper model the deployed plugin sends.`,
      `The deployed ${PLUGIN_ID} plugin (${deployed.root}) pins HELPER_MODELS = ${JSON.stringify(deployed.helperModels)}, read from ${deployed.readFrom}${deployed.build === null ? "" : ` and found in ${deployed.build}`}. With ${providerId} serving ${model}, the helper would run on ${chosen?.model ?? "the thread's own model"}.`,
      `The live layer measures the model the deployed build actually sends and will not report numbers for a different one.`,
      `To measure ${model}, ${remediation}`,
    ].join("\n"),
  );
}
