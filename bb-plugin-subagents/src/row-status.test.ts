// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, mountPluginContentScripts, type MountedPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import type { PluginComposerThreadRowStatus } from "@get-bb/plugin-sdk";
import { rowStatusScript } from "./row-status.ts";

interface ActiveRoot {
  threadId: string;
  working: number;
}

type PolledPayload = { status?: number; body?: { roots: ActiveRoot[] } } | Error;

const fetchCalls: string[] = [];
let responses: PolledPayload[] = [];

vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
  fetchCalls.push(String(input));
  void init;
  const entry = responses.shift() ?? { body: { roots: [] } };
  if (entry instanceof Error) return Promise.reject(entry);
  if (entry.status && entry.status !== 200) return Promise.resolve(new Response("nope", { status: entry.status }));
  return Promise.resolve(
    new Response(JSON.stringify(entry.body ?? { roots: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

beforeEach(() => {
  vi.useFakeTimers();
  responses = [];
  fetchCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushPoll() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

describe("row-status content script through the harness", () => {
  let scripts: MountedPluginContentScripts | null = null;
  afterEach(async () => {
    if (scripts) await scripts.lifecycle.dispose();
    scripts = null;
  });

  async function mountScripts(options: { pluginId: string; omitExperimentalThreadRowStatus?: boolean }) {
    const app = await loadPluginApp(() => import("../app.tsx"));
    scripts = await mountPluginContentScripts(app, options);
    await flushPoll();
    return scripts;
  }

  it("marks rows with active subagents from the mount-time poll", async () => {
    responses = [{ body: { roots: [{ threadId: "busy", working: 2 }] } }];
    const mounted = await mountScripts({ pluginId: "subagents" });
    expect(fetchCalls).toEqual(["/api/v1/plugins/subagents/http/active-rows"]);
    expect(mounted.inspection.getThreadRowStatus("busy")).toEqual({
      icon: "Bot",
      label: "2 subagents running",
      tone: "running",
    });
  });

  it("polls on the interval and clears rows a later poll no longer reports", async () => {
    responses = [{ body: { roots: [{ threadId: "busy", working: 1 }] } }];
    const mounted = await mountScripts({ pluginId: "subagents" });
    expect(mounted.inspection.getThreadRowStatus("busy")).toMatchObject({ tone: "running" });
    responses = [{ body: { roots: [] } }];
    await vi.advanceTimersByTimeAsync(5000);
    await flushPoll();
    expect(fetchCalls).toHaveLength(2);
    expect(mounted.inspection.getThreadRowStatus("busy")).toBeNull();
    expect(mounted.inspection.threadRowStatusCalls.at(-1)).toEqual({ threadId: "busy", status: null });
  });

  it("keeps previous statuses through failed polls and resumes after them", async () => {
    responses = [{ body: { roots: [{ threadId: "busy", working: 1 }] } }];
    const mounted = await mountScripts({ pluginId: "subagents" });
    responses = [new Error("offline"), { status: 500 }, { body: { roots: [{ threadId: "busy", working: 3 }] } }];
    await vi.advanceTimersByTimeAsync(5000);
    await flushPoll();
    expect(mounted.inspection.getThreadRowStatus("busy")).toMatchObject({ label: "1 subagent running" });
    await vi.advanceTimersByTimeAsync(5000);
    await flushPoll();
    expect(mounted.inspection.getThreadRowStatus("busy")).toMatchObject({ label: "1 subagent running" });
    await vi.advanceTimersByTimeAsync(5000);
    await flushPoll();
    expect(fetchCalls).toHaveLength(4);
    expect(mounted.inspection.getThreadRowStatus("busy")).toEqual({
      icon: "Bot",
      label: "3 subagents running",
      tone: "running",
    });
  });

  it("stops polling after dispose and leaves no rows decorated", async () => {
    responses = [{ body: { roots: [{ threadId: "busy", working: 1 }] } }];
    const mounted = await mountScripts({ pluginId: "subagents" });
    await mounted.lifecycle.dispose();
    const polled = fetchCalls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchCalls).toHaveLength(polled);
    expect(mounted.inspection.getThreadRowStatus("busy")).toBeNull();
    expect(mounted.inspection.disposed).toBe(true);
  });

  it("mounts as a no-op and never polls on hosts without the experimental setter", async () => {
    responses = [{ body: { roots: [{ threadId: "busy", working: 1 }] } }];
    const mounted = await mountScripts({ pluginId: "subagents", omitExperimentalThreadRowStatus: true });
    expect(mounted.inspection.mountedIds).toEqual(["row-status"]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchCalls).toHaveLength(0);
    expect(mounted.inspection.threadRowStatusCalls).toEqual([]);
  });
});

describe("row-status disposer and abort cleanup", () => {
  interface RecordedCall {
    threadId: string;
    status: PluginComposerThreadRowStatus | null;
  }
  async function mountDirect() {
    const calls: RecordedCall[] = [];
    const controller = new AbortController();
    const result = rowStatusScript.mount({
      pluginId: "subagents",
      generation: 1,
      signal: controller.signal,
      experimental_setThreadRowStatus: (threadId, status) => calls.push({ threadId, status }),
    });
    expect(typeof result).toBe("function");
    const disposer = result as () => void;
    await flushPoll();
    return { calls, controller, disposer };
  }

  it("the disposer stops the timer and clears every status it set", async () => {
    responses = [{ body: { roots: [{ threadId: "busy", working: 1 }] } }];
    const { calls, controller, disposer } = await mountDirect();
    expect(calls).toHaveLength(1);
    expect(controller.signal.aborted).toBe(false);
    disposer();
    expect(calls.filter(call => call.status === null).map(call => call.threadId)).toEqual(["busy"]);
    const polled = fetchCalls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchCalls).toHaveLength(polled);
  });

  it("the abort signal stops the timer and clears every status it set", async () => {
    responses = [{ body: { roots: [{ threadId: "busy", working: 1 }] } }];
    const { calls, controller } = await mountDirect();
    expect(calls).toHaveLength(1);
    controller.abort();
    expect(calls.filter(call => call.status === null).map(call => call.threadId)).toEqual(["busy"]);
    const polled = fetchCalls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchCalls).toHaveLength(polled);
  });
});
