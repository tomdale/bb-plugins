// Times the syntax tokenizer on a 200-line excerpt of each of several languages:
// the first call in a fresh process (engine start, grammar load and compile),
// then the median of warm calls. Run from the plugin directory:
//
//   node --experimental-transform-types --no-warnings scripts/measure-highlight.ts
import { readFileSync } from "node:fs";
import { highlightTexts } from "../src/syntax/tokenizer.ts";

const SAMPLES: Array<[path: string, source: string]> = [
  ["src/ui/Figure.tsx", "src/ui/Figure.tsx"],
  ["src/service.ts", "src/service.ts"],
  ["app.css", "app.css"],
  ["package-lock.json", "package-lock.json"],
  ["docs/redesign-contract.md", "docs/redesign-contract.md"],
];

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const rows: string[] = [];
for (const [path, source] of SAMPLES) {
  const text = readFileSync(source, "utf8").split("\n").slice(0, 200).join("\n");
  const first = performance.now();
  await highlightTexts(path, [text]);
  const cold = performance.now() - first;
  const warm: number[] = [];
  for (let run = 0; run < 15; run += 1) {
    const started = performance.now();
    await highlightTexts(path, [text]);
    warm.push(performance.now() - started);
  }
  rows.push(`${path.padEnd(28)} cold ${cold.toFixed(0).padStart(5)} ms   warm median ${median(warm).toFixed(1).padStart(6)} ms   (${text.length} chars)`);
}
console.log(rows.join("\n"));
