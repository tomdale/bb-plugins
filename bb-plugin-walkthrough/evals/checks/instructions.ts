// BB truncates each delivered instruction text at 4096 characters, and a
// truncated instruction is a silent loss of the rule it was carrying (the
// streamed-message requirement is at the end of the plan instructions).
import { OPEN_INSTRUCTIONS } from "../../src/tools.ts";
import { PLAN_INSTRUCTIONS, SUGGEST_INSTRUCTIONS, WORKER_GUIDE, WRAP_UP_INSTRUCTIONS, WRITE_PART_INSTRUCTIONS } from "../../src/worker.ts";
import { ok } from "./expect.ts";
import type { Check } from "./check.ts";

const LIMIT = 4096;

export const instructionChecks: Check[] = [
  {
    name: "instructions: every delivered instruction text is under BB's 4096 characters",
    run() {
      const delivered: Record<string, string> = {
        WORKER_GUIDE,
        "walkthrough_open": OPEN_INSTRUCTIONS,
        "walkthrough_plan": PLAN_INSTRUCTIONS,
        "walkthrough_write_part": WRITE_PART_INSTRUCTIONS,
        "walkthrough_suggest": SUGGEST_INSTRUCTIONS,
        "walkthrough_wrap_up": WRAP_UP_INSTRUCTIONS,
      };
      let longest = { name: "", length: 0 };
      for (const [name, text] of Object.entries(delivered)) {
        ok(text.length > 0, `${name} is delivered and not empty`);
        ok(text.length <= LIMIT, `${name} is ${text.length} characters, over BB's ${LIMIT}`);
        if (text.length > longest.length) longest = { name, length: text.length };
      }
      return `longest: ${longest.name} at ${longest.length} of ${LIMIT}`;
    },
  },
];
