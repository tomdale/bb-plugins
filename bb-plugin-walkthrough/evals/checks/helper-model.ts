// The helper's model, as the request shows it: a preference the provider does
// not serve, and a pinned model the server rejects, both have to keep the
// walkthrough alive on the thread's own model instead of failing to send.
import { HELPER_MODELS, HELPER_REASONING } from "../../src/service.ts";
import { settle, setup, THREAD } from "../../tests/helpers.ts";
import { equal, includes, ok } from "./expect.ts";
import type { Check } from "./check.ts";

const REQUEST = "Give me a walkthrough of my uncommitted changes in this repo (staged and unstaged).";
const LUNA = "vercel-ai-gateway/openai/gpt-6-luna";
const levels = (...efforts: string[]) => efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" }));

export const helperModelChecks: Check[] = [
  {
    name: "helper model: a provider serving no preference keeps the thread's model",
    async run() {
      const catalog = () => ({ models: [{ id: "anthropic/claude-opus-5.5" }, { id: "google/gemini-3.8-flash" }] });
      const { rpc, sent } = await setup({ catalog });
      await rpc("start", { threadId: THREAD, request: REQUEST });
      await settle();
      equal(sent.length, 1, "the request is still sent");
      equal(sent[0].model, undefined, "no model is pinned");
      equal(sent[0].reasoningLevel, HELPER_REASONING, "the helper reasons at medium");
      includes(sent[0].text, "[Walkthrough wt_", "the request is the plan request");
      return `${HELPER_MODELS.length} preferences, none served`;
    },
  },
  {
    name: "helper model: a rejected pin falls back to the thread's model",
    async run() {
      const attempts: Array<{ model: string | undefined; reasoningLevel: string | undefined }> = [];
      const { rpc, sent } = await setup({
        catalog: () => ({ models: [{ id: LUNA, supportedReasoningEfforts: levels("low", "medium", "high"), defaultReasoningEffort: "medium" }] }),
        sendError: (args) => {
          attempts.push({ model: args.model, reasoningLevel: args.reasoningLevel });
          return args.model === undefined ? null : new Error(`Model ${args.model} is not available`);
        },
      });
      await rpc("start", { threadId: THREAD, request: REQUEST });
      await settle();
      equal(
        attempts,
        [
          { model: LUNA, reasoningLevel: HELPER_REASONING },
          { model: LUNA, reasoningLevel: undefined },
          { model: undefined, reasoningLevel: HELPER_REASONING },
        ],
        "the fallback chain",
      );
      equal(sent.length, 1, "one request is delivered");
      equal(sent[0].model, undefined, "the delivered request names no model");
      ok(sent[0].text.length > 0, "the delivered request carries the plan instructions");
      return "pinned+level, pinned, thread's model at medium";
    },
  },
];
