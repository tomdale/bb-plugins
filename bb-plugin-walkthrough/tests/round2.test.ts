// Round two: the thread's tab, reader-facing names for notes, tool activity, and the small pure pieces behind placement.
import { describe, expect, it } from "vitest";
import { deliverView } from "../src/deliver.ts";
import { filesRead } from "../src/coverage.ts";
import { describeNoteForThread, noteMarkers, scrubNoteIds, tabTitle } from "../src/model.ts";
import { notesFileName, saveNotes } from "../src/save-notes.ts";
import { isHelperWork } from "../src/service.ts";
import { StreamTail, WORK_EVERY_MS, type TailTarget } from "../src/stream-tail.ts";
import { panelTabId, WalkthroughTabs } from "../src/tabs.ts";
import { WORKER_GUIDE, WRAP_UP_INSTRUCTIONS } from "../src/worker.ts";
import { PLAN, setup, settle, THREAD } from "./helpers.ts";

const note = (id: string, createdAt: number, extra: Record<string, unknown> = {}) =>
  ({ id, walkthroughId: "wt_1", kind: "todo", text: `text ${id}`, groupIndex: 0, location: null, quote: null, status: "open", resolution: null, author: "user", createdAt, updatedAt: createdAt, ...extra }) as never;

describe("the thread's tab", () => {
  const tabsFake = () => {
    const state = { revision: 3, tabs: [{ id: "plugin-fixed:core:info", kind: "plugin-fixed" }] as Array<Record<string, unknown>>, updates: [] as unknown[], conflicts: 0 };
    return {
      state,
      area: {
        get: async () => ({ revision: state.revision, tabs: structuredClone(state.tabs) }),
        update: async (args: { expectedRevision: number; tabs: Array<Record<string, unknown>> }) => {
          if (state.conflicts > 0) {
            state.conflicts -= 1;
            state.revision += 1;
            throw new Error("revision conflict");
          }
          if (args.expectedRevision !== state.revision) throw new Error("revision conflict");
          state.updates.push(args);
          state.tabs = args.tabs;
          state.revision += 1;
          return {};
        },
      },
    };
  };

  it("names a tab the way the host derives it from the panel and its params", () => {
    expect(panelTabId("walkthrough", "wt_1")).toBe("plugin-panel:walkthrough%3Awalkthrough%3A%7B%22walkthroughId%22%3A%22wt_1%22%7D:none");
    expect(tabTitle("Walkthrough")).toBe("Walkthrough");
    expect(tabTitle("TTL cache")).toBe("Walkthrough: TTL cache");
  });

  it("starts a walkthrough from the thread tool with a persisted tab, then gives it the plan's name", async () => {
    const { area, state } = tabsFake();
    const { tool, rpc, idle, walkthroughsOf } = await openedByTool(area);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]).toMatchObject({ kind: "plugin-panel", pluginId: "walkthrough", actionId: "walkthrough", title: "Walkthrough" });
    expect(JSON.parse(String(state.tabs[1]!.paramsJson))).toEqual({ walkthroughId: walkthroughsOf() });
    // The first tab (the host's own) is carried through untouched.
    expect(state.tabs[0]).toEqual({ id: "plugin-fixed:core:info", kind: "plugin-fixed" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    expect(state.tabs[1]!.title).toBe("Walkthrough: Read aloud plugin");
    expect(state.tabs).toHaveLength(2);
    void rpc;
  });

  it("does not add a tab when the starter starts the walkthrough: the starter's own tab shows it", async () => {
    const { area, state } = tabsFake();
    const { rpc, tool } = await setup({ tabs: area });
    await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await settle();
    expect(state.updates).toEqual([]);
  });

  it("reads again and retries when another writer moved the revision", async () => {
    const { area, state } = tabsFake();
    state.conflicts = 1;
    const tabs = new WalkthroughTabs({ pluginId: "walkthrough", log: { warn() {} }, sdk: { threads: { tabs: area } } } as never);
    expect(await tabs.ensure({ id: "wt_1", threadId: THREAD, title: "Walkthrough" })).toBe(true);
    expect(state.tabs.some((tab) => tab.kind === "plugin-panel")).toBe(true);
  });

  it("leaves things alone when the thread cannot hold tabs or the write keeps failing", async () => {
    const warnings: string[] = [];
    const log = { warn: (message: string) => warnings.push(message) };
    expect(await new WalkthroughTabs({ pluginId: "walkthrough", log, sdk: { threads: {} } } as never).ensure({ id: "wt_1", threadId: THREAD, title: "x" })).toBe(false);
    const failing = { get: async () => ({ revision: 1, tabs: [] }), update: async () => { throw new Error("nope"); } };
    expect(await new WalkthroughTabs({ pluginId: "walkthrough", log, sdk: { threads: { tabs: failing } } } as never).ensure({ id: "wt_1", threadId: THREAD, title: "x" })).toBe(false);
    expect(warnings[0]).toContain("could not persist the Walkthrough tab");
  });

  it("renames a tab only when one is there", async () => {
    const { area, state } = tabsFake();
    const tabs = new WalkthroughTabs({ pluginId: "walkthrough", log: { warn() {} }, sdk: { threads: { tabs: area } } } as never);
    expect(await tabs.ensure({ id: "wt_1", threadId: THREAD, title: "Named" }, { onlyIfPresent: true })).toBe(false);
    expect(state.updates).toEqual([]);
  });
});

async function openedByTool(area: unknown) {
  const ctx = await setup({ tabs: area as never });
  const result = await ctx.tool("walkthrough_open", { request: "Walk me through it" }, THREAD);
  expect(JSON.stringify(result)).toContain("pane is open beside this thread now");
  await settle();
  const walkthroughsOf = () => (ctx.bb.storage.database().prepare("SELECT id FROM walkthroughs_v2").get() as { id: string }).id;
  return { ...ctx, walkthroughsOf };
}

describe("notes named for the reader", () => {
  const notes = [note("n1", 10, { kind: "note" }), note("n2", 20, { kind: "todo" }), note("n3", 30, { author: "agent", kind: "note" })];

  it("letters the reader's notes in the order the pane does, and not the agent's", () => {
    expect([...noteMarkers(notes)]).toEqual([["n1", "a"], ["n2", "b"]]);
  });

  it("replaces an id in the worker's prose with 'your todo (b)' and leaves other text alone", () => {
    expect(scrubNoteIds("I proposed an outcome for n1; n2 remains open. Not n9, and not an0.", notes)).toBe("I proposed an outcome for your note (a); your todo (b) remains open. Not n9, and not an0.");
    expect(scrubNoteIds("About n3.", notes)).toBe("About the helper's note.");
    expect(scrubNoteIds("No ids here.", notes)).toBe("No ids here.");
  });

  it("scrubs everything the reader receives: wrap-up, parts, answers, outcomes", () => {
    const walkthrough = (setupWalkthrough() as unknown) as Parameters<typeof deliverView>[0]["walkthrough"];
    const view = deliverView({ walkthrough, notes: [note("n1", 10, { text: "x", resolution: "see n2", proposedResolution: "n1 is answered" }), note("n2", 20, { text: "y" })], reviewDraft: null });
    const text = JSON.stringify(view.walkthrough) + view.notes.map((entry) => `${entry.resolution} ${entry.proposedResolution}`).join(" ");
    expect(text).not.toMatch(/\bn\d+\b/u);
    expect(view.walkthrough.wrapUp!.blocks[0]).toMatchObject({ text: "Proposed an outcome for your todo (a); your todo (b) stays open." });
    expect(view.notes[0]).toMatchObject({ resolution: "see your todo (b)", proposedResolution: "your todo (a) is answered" });
  });

  it("sends the thread notes by their marker, never by id", () => {
    const line = describeNoteForThread({ parts: [{ title: "Schema" }] } as never, notes[1] as never, noteMarkers(notes));
    expect(line).toBe('- your todo (b) [Schema]: "text n2"');
  });

  it("tells the worker the markers, and tells it never to write ids for the reader", () => {
    expect(WORKER_GUIDE).toContain("never by its id");
    expect(WRAP_UP_INSTRUCTIONS).toContain("never by id");
  });

  it("hands open items to the thread without an internal id", async () => {
    const { rpc, sent, tool, idle } = await setup();
    const { walkthroughId } = await rpc("start", { threadId: THREAD, request: "" });
    await settle();
    await tool("walkthrough_plan", PLAN);
    await idle("Planned.");
    await settle();
    await rpc("addNote", { walkthroughId, kind: "todo", text: "Name the cap", groupIndex: 0 });
    await rpc("addNote", { walkthroughId, kind: "question", text: "Why a cap?", groupIndex: 0 });
    expect(await rpc("handOff", { walkthroughId })).toEqual({ sent: true });
    const message = sent.at(-1)!.text;
    expect(message).toContain('your todo (a) [Keeping speech requests small]: "Name the cap"');
    expect(message).toContain('your question (b) [Keeping speech requests small]: "Why a cap?"');
    expect(message).not.toMatch(/\bn\d+\b/u);
  });
});

function setupWalkthrough() {
  const part = (text: string) => ({ title: "P", summary: "", locations: [], status: "ready", blocks: [{ kind: "prose", text }], suggestions: [], message: null, discussion: [{ id: "e1", question: "q", answer: "See n1.", status: "done", askedAt: 1 }] });
  return {
    id: "wt_1", threadId: THREAD, workerThreadId: "w", request: "r", status: "wrapping-up", message: null, title: "T", mode: "local", baseRef: "main", includeUncommitted: true, pr: null,
    introduction: "Intro mentions n1.", parts: [part("Part n2.")], currentPart: 0, wrapUp: part("Proposed an outcome for n1; n2 stays open."), environmentId: null, hostId: null, workspacePath: null,
    review: null, queue: [], inFlight: null, nextNoteNumber: 3, nextExchangeNumber: 2, createdAt: 1, updatedAt: 1,
  };
}

describe("saving notes", () => {
  it("writes into the thread's own storage, which needs no repository", async () => {
    const writes: Array<{ hostId: string; path: string; content: string }> = [];
    const sdk = {
      threads: { storageLocation: async () => ({ hostId: "host_9", storageRootPath: "/data/thr/" }) },
      files: { write: async (args: { hostId: string; path: string; content: string }) => void writes.push(args) },
    };
    const walkthrough = { ...setupWalkthrough(), id: "wt_abc", title: "How p-limit works", environmentId: null, hostId: null, workspacePath: null };
    const saved = await saveNotes(sdk as never, walkthrough as never, [note("n1", 1, { status: "open" }), note("n2", 2, { status: "resolved" })]);
    expect(saved).toEqual({ threadId: THREAD, path: "walkthrough-notes/how-p-limit-works-abc.md", absolutePath: "/data/thr/walkthrough-notes/how-p-limit-works-abc.md", notes: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ hostId: "host_9", path: saved.absolutePath });
    expect(writes[0]!.content).toContain("text n1");
    expect(writes[0]!.content).not.toContain("text n2");
    expect(notesFileName(walkthrough as never)).toBe("how-p-limit-works-abc.md");
  });
});

describe("what the helper is doing during the first silence", () => {
  it("counts reading, searching and commands, and not thinking, talking or the plugin's own tools", () => {
    expect(isHelperWork({ item: { type: "commandExecution", command: "cat a.ts" } })).toBe(true);
    expect(isHelperWork({ item: { type: "fileChange" } })).toBe(true);
    expect(isHelperWork({ item: { type: "reasoning" } })).toBe(false);
    expect(isHelperWork({ item: { type: "agentMessage" } })).toBe(false);
    expect(isHelperWork({ item: { type: "mcpToolCall", tool: "walkthrough_plan" } })).toBe(false);
    expect(isHelperWork({})).toBe(false);
  });

  it("counts the helper's steps in the plan turn's payload, looking at most once a second", async () => {
    let now = 0;
    let batch = 2;
    const tail = new StreamTail(
      {
        readDeltas: async () => [],
        readWork: async (_thread, after) => ({ count: batch, cursor: after + batch }),
        publish: () => undefined,
      },
      () => now,
    );
    const target: TailTarget = { walkthroughId: "wt_1", workerThreadId: "w", request: { kind: "plan" }, afterSeq: 0, sentAt: 1 };
    tail.track(target);
    now = 10;
    const first = await tail.snapshot(target);
    expect(first?.steps).toBe(2);
    now += WORK_EVERY_MS / 2;
    batch = 5;
    expect((await tail.snapshot(target))?.steps).toBe(2);
    now += WORK_EVERY_MS;
    expect((await tail.snapshot(target))?.steps).toBe(7);
    tail.dispose();
  });
});

describe("files an overview read", () => {
  it("lists the files its written parts cite, once, relative to the workspace", () => {
    const part = (status: string, paths: string[]) => ({ status, locations: [], blocks: paths.map((path) => ({ kind: "code", path })) });
    const read = filesRead({ workspacePath: "/w", parts: [part("ready", ["/w/src/a.ts", "src/b.ts"]), part("ready", ["src/a.ts"]), part("writing", ["src/c.ts"])], wrapUp: null } as never);
    expect(read).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
