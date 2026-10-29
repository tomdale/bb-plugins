import { relayArtifact } from "./relay-artifact.js";

/** A sentinel argv keeps the source CLI guard inactive when importing the bundle. */
export function relayLaunchArgs(root: string) {
  return ["--input-type=module", "-e",
    'import{readFile}from"node:fs/promises";import{createHash}from"node:crypto";import{pathToFileURL}from"node:url";try{const p=process.argv[2];if(createHash("sha256").update(await readFile(p)).digest("hex")!==process.argv[3])throw 0;const{runRelay}=await import(pathToFileURL(p).href);const relay=await runRelay(JSON.parse(await readFile(process.argv[4],"utf8")));process.on("SIGTERM",()=>void relay.close());process.on("SIGINT",()=>void relay.close());}catch{process.stderr.write("Machine relay could not start\\n");process.exitCode=1;}',
    "bb-relay-artifact", `${root}/relay.mjs`, relayArtifact.sha256, `${root}/config.json`];
}
