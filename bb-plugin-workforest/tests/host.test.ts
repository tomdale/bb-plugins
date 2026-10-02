import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { detail } from "./fixtures.js";

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../workforest.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workforest.js")>();
  return {
    ...original,
    createWorkforest: () => ({ detail: async () => detail }),
    runCommand: commands.run,
  };
});
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.resetModules();
});
async function setup() {
  const { default: entry } = await import("../host.js");
  const harness = experimental_createHostEntryHarness(entry);
  disposers.push(() => harness.experimental_dispose());
  return harness;
}
describe("host operation lifecycle", () => {
  it("creates a task from the resolved repository and returns fresh metadata", async () => {
    commands.run.mockResolvedValue("created");
    const host = await setup();
    expect(
      await host.experimental_call("createTask", {
        selector: detail.selector,
        repository: "app",
        name: "tests",
        setup: true,
      }),
    ).toEqual({ path: detail.tasks[0]!.path, branch: detail.tasks[0]!.branch });
    expect(commands.run).toHaveBeenLastCalledWith(
      ["task", "new", "tests", "--setup", "--json"],
      expect.objectContaining({ cwd: detail.repositories[0]!.path }),
    );
  });
  it("serializes task creation with other machine mutations and releases failed tasks", async () => {
    let finish!: () => void;
    commands.run.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("created");
        }),
    );
    const host = await setup();
    const creating = host.experimental_call("createTask", {
      selector: detail.selector,
      repository: "app",
      name: "tests",
      setup: false,
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(
      host.experimental_call("start", {
        kind: "create",
        name: "other",
        sources: ["o/r"],
      }),
    ).rejects.toThrow("Another");
    finish();
    await creating;
    commands.run.mockRejectedValue(new Error("failed"));
    await expect(
      host.experimental_call("createTask", {
        selector: detail.selector,
        repository: "app",
        name: "tests",
        setup: false,
      }),
    ).rejects.toThrow("failed");
    commands.run.mockResolvedValue("created");
    await expect(
      host.experimental_call("createTask", {
        selector: detail.selector,
        repository: "app",
        name: "tests",
        setup: false,
      }),
    ).resolves.toBeDefined();
  });
  it("returns immediately, prevents concurrent mutations, and records completion", async () => {
    let finish!: (value: string) => void;
    commands.run.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const host = await setup();
    const job = await host.experimental_call("start", {
      kind: "create",
      name: "demo",
      sources: ["o/r"],
    });
    expect(job.state).toBe("running");
    await expect(
      host.experimental_call("start", {
        kind: "create",
        name: "other",
        sources: ["o/r"],
      }),
    ).rejects.toThrow("Another");
    finish("created");
    await vi.waitFor(async () =>
      expect((await host.experimental_call("jobs", null))[0]?.state).toBe(
        "succeeded",
      ),
    );
  });
  it("releases the mutation lock after synchronous command validation fails", async () => {
    commands.run.mockResolvedValue("created");
    const host = await setup();
    await host.experimental_call("start", {
      kind: "create",
      name: "demo",
      sources: ["@template", "o/r"],
    });
    await vi.waitFor(async () =>
      expect((await host.experimental_call("jobs", null))[0]?.state).toBe(
        "failed",
      ),
    );
    await expect(
      host.experimental_call("start", {
        kind: "create",
        name: "valid",
        sources: ["o/r"],
      }),
    ).resolves.toBeDefined();
  });
  it("reports mutation failures instead of success", async () => {
    commands.run.mockRejectedValue(new Error("mirror fetch failed"));
    const host = await setup();
    await host.experimental_call("start", {
      kind: "create",
      name: "demo",
      sources: ["o/r"],
    });
    await vi.waitFor(async () =>
      expect((await host.experimental_call("jobs", null))[0]).toMatchObject({
        state: "failed",
        output: "mirror fetch failed",
      }),
    );
  });
  it("aborts detached work on plugin disposal", async () => {
    let signal: AbortSignal | undefined;
    commands.run.mockImplementation((_args, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    });
    const host = await setup();
    await host.experimental_call("start", {
      kind: "create",
      name: "demo",
      sources: ["o/r"],
    });
    await host.experimental_dispose();
    expect(signal?.aborted).toBe(true);
  });
});
