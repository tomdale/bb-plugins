// What the service does to make the first words arrive sooner: the helper's
// reasoning is capped, and the first look at the working tree is kept on the
// record for the pane's waiting state.
import { describe, expect, it } from "vitest";
import { HELPER_REASONING } from "../src/service.ts";
import { detectedLine, liveLine } from "../src/ui/live.tsx";
import { settle, setup, THREAD } from "./helpers.ts";

describe("helper latency", () => {
  it("sends the plan request at a capped reasoning level", async () => {
    const { rpc, sent } = await setup();
    await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect(HELPER_REASONING).toBe("medium");
    expect(sent[0]).toMatchObject({ reasoningLevel: "medium" });
  });

  it("retries without the level when the model does not list it", async () => {
    let rejected = false;
    const { rpc, sent } = await setup({
      sendError: () => {
        if (rejected) return null;
        rejected = true;
        return new Error("Reasoning level medium is not supported by this model");
      },
    });
    await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.reasoningLevel).toBeUndefined();
  });

  it("keeps what the first look found on the record", async () => {
    const files = [
      { path: "a.ts", oldPath: null, status: "modified", origins: ["staged"], additions: 4, deletions: 1, binary: false },
      { path: "b.ts", oldPath: null, status: "modified", origins: ["unstaged"], additions: 3, deletions: 0, binary: false },
    ];
    const { rpc, view } = await setup({
      hostRpc: (call) => (call.method === "changedFiles" ? { files, staged: 1, unstaged: 1, untracked: 0, truncated: false, branch: null } : undefined),
    });
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    expect((await view(walkthroughId)).walkthrough.detected).toEqual({ files: 2, staged: 1, unstaged: 1, untracked: 0, additions: 7, deletions: 1 });
  });
});

describe("waiting lines", () => {
  it("summarizes the detected change in plain counts", () => {
    expect(detectedLine({ files: 4, staged: 2, unstaged: 1, untracked: 1, additions: 40, deletions: 8 })).toBe("4 files \u00b7 2 staged, 1 unstaged, 1 untracked \u00b7 +40 \u22128");
    expect(detectedLine({ files: 1, staged: 0, unstaged: 1, untracked: 0, additions: 0, deletions: 0 })).toBe("1 file \u00b7 1 unstaged");
    expect(detectedLine({ files: 0, staged: 0, unstaged: 0, untracked: 0, additions: 0, deletions: 0 })).toBeNull();
    expect(detectedLine(undefined)).toBeNull();
  });

  it("names what the helper is doing without forecasting", () => {
    expect(liveLine({ inFlight: null, workerThreadId: null }, undefined)).toBe("Getting a helper ready\u2026");
    expect(liveLine({ inFlight: { request: { kind: "plan" }, sentAt: 1, afterSeq: 0 }, workerThreadId: "w" }, undefined)).toBe("Reading the code\u2026");
    expect(liveLine({ inFlight: null, workerThreadId: "w" }, 3)).toBe("Looking through the code \u00b7 3 steps so far");
  });
});
