// The scorer is itself under test: every committed message fixture carries the
// verdict it must get, recorded or forbidden, so a scorer that stops noticing a
// heading or a reply wrapper fails here before a live run is spent on it.
import { messageFixtures, messageText } from "../fixtures/load.ts";
import { scoreFormat } from "../scorer/format-score.ts";
import { equal } from "./expect.ts";
import type { Check } from "./check.ts";

export const formatChecks: Check[] = messageFixtures().map((fixture) => ({
  name: `format: ${fixture.file.replace(/\.md$/u, "")}`,
  run() {
    const score = scoreFormat(messageText(fixture.file));
    for (const [key, expected] of Object.entries(fixture.expect)) {
      equal((score as unknown as Record<string, unknown>)[key], expected, `${fixture.file} ${key}`);
    }
    const parts = [`ok=${String(score.ok)}`, `${score.codeFences.length} code fences`, `${score.suggestions.length} suggestions`];
    if (score.findings.length > 0) parts.push(`findings: ${score.findings.join(", ")}`);
    return parts.join(", ");
  },
}));
