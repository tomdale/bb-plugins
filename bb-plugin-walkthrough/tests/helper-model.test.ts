// The helper runs on a cheap, fast model of its own instead of the user's
// model, chosen from the thread's provider catalog, with the thread's own model
// as the fallback when the provider serves none of the preferences.
import { describe, expect, it } from "vitest";
import { HELPER_MODELS, HELPER_REASONING, pickHelperModel } from "../src/service.ts";
import { setup, settle, THREAD } from "./helpers.ts";

const levels = (...efforts: string[]) => efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" }));
const LUNA = "openai/gpt-6-luna";

describe("choosing the helper's model", () => {
  it("prefers the first listed model the provider serves, matching a catalog id with its provider prefix", () => {
    expect(pickHelperModel([{ id: `vercel-ai-gateway/${LUNA}` }])).toEqual({ model: `vercel-ai-gateway/${LUNA}`, reasoningLevel: null });
    expect(pickHelperModel([{ id: "openai/gpt-5.6-luna" }, { id: LUNA }])?.model).toBe(LUNA);
    expect(pickHelperModel([{ id: "openai/gpt-5.6-luna" }])?.model).toBe("openai/gpt-5.6-luna");
  });

  it("asks for medium when the model lists it, and otherwise for its own default", () => {
    expect(pickHelperModel([{ id: LUNA, supportedReasoningEfforts: levels("low", "medium", "high") }])?.reasoningLevel).toBe("medium");
    expect(pickHelperModel([{ id: LUNA, supportedReasoningEfforts: levels("none", "low"), defaultReasoningEffort: "low" }])?.reasoningLevel).toBe("low");
    expect(pickHelperModel([{ id: LUNA, defaultReasoningEffort: "high" }])?.reasoningLevel).toBe("high");
  });

  it("leaves the helper on the thread's own model when the provider serves none of the preferences", () => {
    expect(pickHelperModel([])).toBeNull();
    expect(pickHelperModel([{ id: "anthropic/claude-opus-5.5" }, { id: "openai/gpt-6-astra" }])).toBeNull();
    expect(HELPER_MODELS).toEqual(["openai/gpt-6-luna", "openai/gpt-5.6-luna"]);
  });
});

describe("sending the plan request", () => {
  it("names the cheap model and its level on the plan request", async () => {
    const { rpc, sent } = await setup({ catalog: () => ({ models: [{ id: `vercel-ai-gateway/${LUNA}`, supportedReasoningEfforts: levels("low", "medium", "high"), defaultReasoningEffort: "medium" }] }) });
    await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect(sent[0]).toMatchObject({ model: `vercel-ai-gateway/${LUNA}`, reasoningLevel: HELPER_REASONING });
  }, 20_000);

  it("reads the catalog of the thread's own provider and environment", async () => {
    const asked: Array<{ providerId?: string | undefined; environmentId?: string | undefined }> = [];
    const { rpc } = await setup({
      catalog: (args) => {
        asked.push(args ?? {});
        return { models: [] };
      },
    });
    await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect(asked[0]).toMatchObject({ environmentId: "env_1" });
    expect(asked).toHaveLength(1);
  }, 20_000);

  it("drops a model the provider rejects and finishes the walkthrough on the thread's own model", async () => {
    const { rpc, sent } = await setup({
      catalog: () => ({ models: [{ id: `vercel-ai-gateway/${LUNA}` }] }),
      sendError: (args) => (args.model === undefined ? null : new Error(`Model ${args.model} is not available`)),
    });
    await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.model).toBeUndefined();
    expect(sent[0]!.reasoningLevel).toBe(HELPER_REASONING);
  }, 20_000);

  it("starts a fresh worker on the pinned model when the fork fails", async () => {
    const { rpc, spawns } = await setup({ forkFails: true, catalog: () => ({ models: [{ id: LUNA, supportedReasoningEfforts: levels("low", "medium") }] }) });
    await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect(spawns[0]).toMatchObject({ model: LUNA, reasoningLevel: "medium" });
  }, 20_000);
});
