// One-off repair of walkthroughs that saved helper narration as content ("Now
// let me set up the walkthrough plan.", "Done, part 3 committed."). It reads the
// plugin's database, finds the introductions and parts the narration rules
// (src/narration.ts) change, and prints each change as a diff.
//
//   node --experimental-transform-types --no-warnings scripts/repair-narration.ts <data.db>            dry run
//   node --experimental-transform-types --no-warnings scripts/repair-narration.ts <data.db> --write    apply
//
// --write first copies the database to <data.db>.bak-<timestamp> (VACUUM INTO,
// a consistent copy even while BB has the database open), then updates only the
// affected rows in one transaction. Running it again finds nothing to change.
// Stop BB's plugin or reload it afterwards: the plugin may hold a row in memory.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { repairNarration, type RepairableWalkthrough } from "../src/repair.ts";

const args = process.argv.slice(2);
const write = args.includes("--write");
const paths = args.filter((arg) => !arg.startsWith("--"));
if (paths.length !== 1) {
  console.error("usage: repair-narration.ts <data.db> [--write]");
  process.exit(2);
}
const path = paths[0]!;
if (!existsSync(path)) {
  console.error(`no such database: ${path}`);
  process.exit(2);
}

interface Row {
  id: string;
  data: string;
}
type Stored = RepairableWalkthrough & { title?: string };

const database = new DatabaseSync(path);
database.exec("PRAGMA busy_timeout = 5000");
const rows = database.prepare("SELECT id, data FROM walkthroughs_v2").all() as unknown as Row[];

const quote = (prefix: string, text: string): string =>
  text
    .split("\n")
    .map((line) => `${prefix} ${line}`)
    .join("\n");

const updates: Array<{ id: string; data: string }> = [];
let removedCount = 0;
for (const row of rows) {
  let stored: Stored;
  try {
    stored = JSON.parse(row.data) as Stored;
  } catch {
    console.error(`skipping ${row.id}: unreadable data`);
    continue;
  }
  if (typeof stored.introduction !== "string" || !Array.isArray(stored.parts)) continue;
  const { walkthrough, changes } = repairNarration(stored);
  if (changes.length === 0) continue;
  removedCount += changes.length;
  console.log(`\n=== ${row.id}  ${stored.title ?? ""}`);
  for (const change of changes) console.log(`@@ ${change.where}\n${quote("-", change.removed)}`);
  updates.push({ id: row.id, data: JSON.stringify(walkthrough) });
}

console.log(`\n${updates.length} of ${rows.length} walkthroughs have narration (${removedCount} paragraphs).`);
if (!write) {
  console.log(updates.length === 0 ? "Nothing to repair." : "Dry run: nothing was written. Pass --write to apply.");
} else if (updates.length > 0) {
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  database.exec(`VACUUM INTO '${backup.replace(/'/gu, "''")}'`);
  console.log(`Backup: ${backup}`);
  const update = database.prepare("UPDATE walkthroughs_v2 SET data = ? WHERE id = ?");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const item of updates) update.run(item.data, item.id);
    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
  console.log(`Updated ${updates.length} walkthroughs.`);
}
database.close();
