import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { MAX_SNOOZE_MS, nextSnoozeWake } from "./server";

const THREAD_ID = "thr_test";

async function setup() {
  const archive = vi.fn(async () => ({
    archivedThreadIds: [THREAD_ID],
    ok: true as const,
  }));
  const unarchive = vi.fn(async ({ threadId }: { threadId: string }) => ({
    unarchived: 1,
  }));
  const get = vi.fn(async ({ threadId }: { threadId: string }) =>
    makeThreadResponse({ id: threadId, archivedAt: null }),
  );
  const experimental_listCascade = vi.fn(async () => ({
    threads: [{ threadId: THREAD_ID, cascadeThreadIds: [THREAD_ID] }],
  }));
  const experimental_listAncestors = vi.fn(
    async ({ threadIds }: { threadIds: readonly string[] }) => ({
      threads: threadIds.map((threadId) => ({
        threadId,
        ancestorIds: threadId === THREAD_ID ? [] : [THREAD_ID],
      })),
    }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "quick-actions",
    sdk: {
      threads: {
        archive,
        unarchive,
        get,
        experimental_listCascade,
        experimental_listAncestors,
      },
    },
  });
  await plugin(bb);
  return {
    bb,
    harness,
    archive,
    unarchive,
    get,
    experimental_listCascade,
    experimental_listAncestors,
  };
}

describe("Snooze", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T15:30:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes 9:00 AM the next day in server-local time", () => {
    const now = new Date("2026-11-09T15:30:00");
    const wake = new Date(now);
    wake.setDate(wake.getDate() + 1);
    wake.setHours(9, 0, 0, 0);
    expect(nextSnoozeWake(now)).toBe(wake.getTime());
  });

  it("persists the wake time and archives the thread", async () => {
    const { bb, harness, archive } = await setup();
    const result = (await harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    })) as { threadId: string; wakeAt: number; snoozedThreadIds: string[] };
    expect(result.threadId).toBe(THREAD_ID);
    expect(result.wakeAt).toBe(nextSnoozeWake(new Date()));
    expect(archive).toHaveBeenCalledWith({ threadId: THREAD_ID });
    expect(
      bb.storage
        .database()
        .prepare("SELECT thread_id AS threadId, wake_at AS wakeAt FROM snoozes")
        .all(),
    ).toEqual([{ threadId: THREAD_ID, wakeAt: result.wakeAt }]);
    await harness.lifecycle.dispose();
  });

  it("persists a chosen wake time", async () => {
    const { bb, harness, archive } = await setup();
    const wakeAt = new Date("2026-11-14T09:00:00").getTime();
    const result = (await harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
      wakeAt,
    })) as { wakeAt: number };
    expect(result.wakeAt).toBe(wakeAt);
    expect(archive).toHaveBeenCalledWith({ threadId: THREAD_ID });
    expect(
      bb.storage
        .database()
        .prepare("SELECT wake_at AS wakeAt FROM snoozes")
        .all(),
    ).toEqual([{ wakeAt }]);
    await harness.lifecycle.dispose();
  });

  it("refuses a wake time in the past or more than a year out without archiving", async () => {
    const { bb, harness, archive } = await setup();
    for (const wakeAt of [Date.now(), Date.now() + MAX_SNOOZE_MS + 1]) {
      await expect(
        harness.behavior.callRpc("snooze", { threadId: THREAD_ID, wakeAt }),
      ).rejects.toThrow(/Snooze wake time must be/);
    }
    expect(archive).not.toHaveBeenCalled();
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("wakes due threads on the durable schedule", async () => {
    const { bb, harness, unarchive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = ?")
      .run(THREAD_ID);
    await harness.behavior.runSchedule("snooze-wake");
    expect(unarchive).toHaveBeenCalledWith({ threadId: THREAD_ID });
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("reconciles due threads when the startup service runs", async () => {
    const { bb, harness, unarchive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = ?")
      .run(THREAD_ID);
    const service = harness.behavior.runService("snooze-startup");
    await service.done;
    expect(unarchive).toHaveBeenCalledWith({ threadId: THREAD_ID });
    await harness.lifecycle.dispose();
  });

  it("retains a due record after a wake failure and retries it", async () => {
    const { bb, harness, unarchive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = ?")
      .run(THREAD_ID);
    unarchive.mockRejectedValueOnce(new Error("host offline"));
    await harness.behavior.runSchedule("snooze-wake");
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(1);
    expect(JSON.stringify(harness.logEntries)).toContain(
      "Could not wake snoozed thread",
    );
    await harness.behavior.runSchedule("snooze-wake");
    expect(unarchive).toHaveBeenCalledTimes(2);
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("cancels a snooze when the thread is manually unarchived", async () => {
    const { bb, harness } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({
        id: THREAD_ID,
        archivedAt: null,
        updatedAt: Date.now() + 1000,
      }),
    });
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("deletes a new wake record when the first archive fails", async () => {
    const { bb, harness, archive } = await setup();
    archive.mockRejectedValueOnce(new Error("archive failed"));
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("archive failed");
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("restores the previous wake time when archiving fails", async () => {
    const { bb, harness, archive } = await setup();
    const first = (await harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    })) as { threadId: string; wakeAt: number; snoozedThreadIds: string[] };
    archive.mockRejectedValueOnce(new Error("archive failed"));
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("archive failed");
    expect(
      bb.storage
        .database()
        .prepare("SELECT thread_id AS threadId, wake_at AS wakeAt FROM snoozes")
        .all(),
    ).toEqual([{ threadId: THREAD_ID, wakeAt: first.wakeAt }]);
    await harness.lifecycle.dispose();
  });

  it("persists and wakes every thread archived by a cascade", async () => {
    const { bb, harness, archive, unarchive } = await setup();
    archive.mockResolvedValueOnce({
      archivedThreadIds: [THREAD_ID, "thr_child"],
      ok: true,
    });
    const result = (await harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    })) as { snoozedThreadIds: string[] };
    expect(result.snoozedThreadIds).toEqual([THREAD_ID, "thr_child"]);
    expect(
      bb.storage
        .database()
        .prepare("SELECT thread_id AS threadId FROM snoozes ORDER BY thread_id")
        .all(),
    ).toEqual([{ threadId: "thr_child" }, { threadId: THREAD_ID }]);
    bb.storage.database().prepare("UPDATE snoozes SET wake_at = 0").run();
    await harness.behavior.runSchedule("snooze-wake");
    expect(unarchive).toHaveBeenCalledWith({ threadId: THREAD_ID });
    expect(unarchive).toHaveBeenCalledWith({ threadId: "thr_child" });
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("extends the remaining snooze group when an archived root is snoozed again", async () => {
    const { bb, harness, archive } = await setup();
    archive.mockResolvedValueOnce({
      archivedThreadIds: [THREAD_ID, "thr_child"],
      ok: true,
    });
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    vi.setSystemTime(new Date("2026-11-10T10:00:00"));
    archive.mockResolvedValueOnce({ archivedThreadIds: [THREAD_ID], ok: true });
    const second = (await harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    })) as { wakeAt: number; snoozedThreadIds: string[] };
    expect(second.snoozedThreadIds).toEqual([THREAD_ID, "thr_child"]);
    expect(
      bb.storage
        .database()
        .prepare(
          "SELECT DISTINCT wake_at AS wakeAt, group_id AS groupId FROM snoozes",
        )
        .all(),
    ).toEqual([{ wakeAt: second.wakeAt, groupId: expect.any(String) }]);
    await harness.lifecycle.dispose();
  });

  it("keeps wake records when an archive commits but its response rejects", async () => {
    const { bb, harness, archive, get } = await setup();
    archive.mockRejectedValueOnce(new Error("response lost"));
    get.mockResolvedValueOnce(
      makeThreadResponse({ id: THREAD_ID, archivedAt: null }),
    );
    get.mockResolvedValueOnce(
      makeThreadResponse({ id: THREAD_ID, archivedAt: Date.now() }),
    );
    const result = (await harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    })) as { threadId: string };
    expect(result.threadId).toBe(THREAD_ID);
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("does not mistake a pre-existing archived root for a committed cascade", async () => {
    const { bb, harness, archive, get, experimental_listCascade } =
      await setup();
    experimental_listCascade.mockResolvedValueOnce({
      threads: [
        { threadId: THREAD_ID, cascadeThreadIds: [THREAD_ID, "thr_new"] },
      ],
    });
    get.mockImplementation(async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        archivedAt: threadId === THREAD_ID ? 1000 : null,
      }),
    );
    archive.mockRejectedValueOnce(new Error("archive rejected"));
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("archive rejected");
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("retains intent for a partially committed archive", async () => {
    const { bb, harness, archive, get, experimental_listCascade } =
      await setup();
    experimental_listCascade.mockResolvedValueOnce({
      threads: [
        { threadId: THREAD_ID, cascadeThreadIds: [THREAD_ID, "thr_child"] },
      ],
    });
    archive.mockRejectedValueOnce(new Error("response lost"));
    let rootReads = 0;
    get.mockImplementation(async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        archivedAt:
          threadId === THREAD_ID && rootReads++ > 0 ? Date.now() : null,
      }),
    );
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("response lost");
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("retains intent when archive verification is inconclusive", async () => {
    const { bb, harness, archive, get } = await setup();
    archive.mockRejectedValueOnce(new Error("response lost"));
    get.mockResolvedValueOnce(
      makeThreadResponse({ id: THREAD_ID, archivedAt: null }),
    );
    get.mockRejectedValueOnce(new Error("verification offline"));
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("response lost");
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it.each([
    { archivedThreadIds: [THREAD_ID, "thr_child"] },
    { archivedThreadIds: ["thr_child", THREAD_ID] },
  ])(
    "unarchives owners before dependents during rollback and clears intent",
    async ({ archivedThreadIds }) => {
      const { bb, harness, archive, unarchive } = await setup();
      bb.storage
        .database()
        .exec(
          "CREATE TRIGGER fail_child_write BEFORE INSERT ON snoozes WHEN NEW.thread_id = 'thr_child' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
        );
      archive.mockResolvedValueOnce({ archivedThreadIds, ok: true });
      await expect(
        harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
      ).rejects.toThrow("write failed");
      expect(unarchive.mock.calls.map(([input]) => input.threadId)).toEqual([
        THREAD_ID,
        "thr_child",
      ]);
      expect(
        bb.storage.database().prepare("SELECT * FROM snoozes").all(),
      ).toEqual([]);
      await harness.lifecycle.dispose();
    },
  );

  it("ignores rollback unarchive events when restoring previous intent", async () => {
    const { bb, harness, archive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    const previousGeneration = (bb.storage
      .database()
      .prepare("SELECT generation FROM snoozes WHERE thread_id = ?")
      .get(THREAD_ID) as { generation: string }).generation;
    bb.storage
      .database()
      .exec(
        "CREATE TRIGGER fail_child_write BEFORE INSERT ON snoozes WHEN NEW.thread_id = 'thr_child' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
      );
    archive.mockResolvedValueOnce({
      archivedThreadIds: [THREAD_ID, "thr_child"],
      ok: true,
    });
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("write failed");
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: THREAD_ID, archivedAt: Date.now() }),
    });
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: THREAD_ID, archivedAt: null }),
    });
    expect(
      (bb.storage
        .database()
        .prepare("SELECT generation FROM snoozes WHERE thread_id = ?")
        .get(THREAD_ID) as { generation: string }).generation,
    ).toBe(previousGeneration);
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: THREAD_ID, archivedAt: null }),
    });
    await vi.waitFor(() => {
      expect(bb.storage.database().prepare("SELECT * FROM snoozes").all()).toEqual([]);
    });
    await harness.lifecycle.dispose();
  });

  it("finishes rollback before allowing a later Snooze", async () => {
    const { bb, harness, archive, unarchive } = await setup();
    bb.storage
      .database()
      .exec(
        "CREATE TRIGGER fail_child_write BEFORE INSERT ON snoozes WHEN NEW.thread_id = 'thr_child' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
      );
    let finishArchive: (() => void) | undefined;
    archive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishArchive = () =>
            resolve({ archivedThreadIds: [THREAD_ID, "thr_child"], ok: true });
        }),
    );
    const first = harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    archive.mockResolvedValueOnce({ archivedThreadIds: [THREAD_ID], ok: true });
    const second = harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    unarchive.mockImplementationOnce(async () => {
      bb.storage.database().exec("DROP TRIGGER fail_child_write");
      return { unarchived: 1 };
    });
    finishArchive?.();
    await expect(first).rejects.toThrow("write failed");
    await second;
    const methods = harness.inspection.sdk.calls.map((call) => call.path);
    expect(methods.indexOf("threads.unarchive")).toBeLessThan(
      methods.lastIndexOf("threads.archive"),
    );
    expect(
      bb.storage
        .database()
        .prepare("SELECT thread_id AS threadId FROM snoozes")
        .all(),
    ).toEqual([{ threadId: THREAD_ID }]);
    await harness.lifecycle.dispose();
  });

  it("does not let an old wake delete a replacement snooze", async () => {
    const { bb, harness, unarchive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = ?")
      .run(THREAD_ID);
    let finishWake: (() => void) | undefined;
    unarchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWake = () => resolve({ unarchived: 1 });
        }),
    );
    const waking = harness.behavior.runSchedule("snooze-wake");
    const replacementPromise = harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    }) as Promise<{ wakeAt: number }>;
    await vi.waitFor(() => expect(unarchive).toHaveBeenCalledTimes(1));
    finishWake?.();
    await waking;
    const replacement = await replacementPromise;
    const replacementRow = bb.storage
      .database()
      .prepare(
        "SELECT generation, wake_at AS wakeAt FROM snoozes WHERE thread_id = ?",
      )
      .get(THREAD_ID);
    expect(
      bb.storage
        .database()
        .prepare(
          "SELECT generation, wake_at AS wakeAt FROM snoozes WHERE thread_id = ?",
        )
        .get(THREAD_ID),
    ).toEqual(replacementRow);
    expect(
      bb.storage
        .database()
        .prepare("SELECT wake_at AS wakeAt FROM snoozes WHERE thread_id = ?")
        .get(THREAD_ID),
    ).toEqual({ wakeAt: replacement.wakeAt });
    await harness.lifecycle.dispose();
  });

  it("ignores delayed unarchive events after the thread is rearchived", async () => {
    const { bb, harness, get } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({
        id: THREAD_ID,
        archivedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    });
    get.mockResolvedValueOnce(
      makeThreadResponse({ id: THREAD_ID, archivedAt: Date.now() }),
    );
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({
        id: THREAD_ID,
        archivedAt: null,
        updatedAt: Date.now() - 1,
      }),
    });
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("skips a stale second wake queued behind a replacement Snooze", async () => {
    const { bb, harness, unarchive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = ?")
      .run(THREAD_ID);
    let finishWake: (() => void) | undefined;
    unarchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWake = () => resolve({ unarchived: 1 });
        }),
    );
    const firstWake = harness.behavior.runSchedule("snooze-wake");
    const replacement = harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    });
    const staleWake = harness.behavior.runSchedule("snooze-wake");
    await vi.waitFor(() => expect(unarchive).toHaveBeenCalledTimes(1));
    finishWake?.();
    await Promise.all([firstWake, replacement, staleWake]);
    expect(unarchive).toHaveBeenCalledTimes(1);
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("restores records from other groups after an archive failure", async () => {
    const { bb, harness, archive, experimental_listCascade } = await setup();
    bb.storage
      .database()
      .prepare(
        "INSERT INTO snoozes (thread_id, group_id, generation, snoozed_at, wake_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("thr_child", "other-group", "other-generation", 1, 100);
    experimental_listCascade.mockResolvedValueOnce({
      threads: [
        { threadId: THREAD_ID, cascadeThreadIds: [THREAD_ID, "thr_child"] },
      ],
    });
    archive.mockRejectedValueOnce(new Error("archive rejected"));
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("archive rejected");
    expect(
      bb.storage
        .database()
        .prepare(
          "SELECT group_id AS groupId, generation FROM snoozes WHERE thread_id = 'thr_child'",
        )
        .get(),
    ).toEqual({ groupId: "other-group", generation: "other-generation" });
    await harness.lifecycle.dispose();
  });

  it("preserves response-only IDs whose rollback unarchive fails", async () => {
    const { bb, harness, archive, unarchive } = await setup();
    bb.storage
      .database()
      .exec(
        "CREATE TRIGGER fail_child_write BEFORE INSERT ON snoozes WHEN NEW.thread_id = 'thr_child' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
      );
    archive.mockResolvedValueOnce({
      archivedThreadIds: [THREAD_ID, "thr_child"],
      ok: true,
    });
    unarchive.mockImplementation(async ({ threadId }) => {
      if (threadId === "thr_child") {
        bb.storage.database().exec("DROP TRIGGER IF EXISTS fail_child_write");
        throw new Error("owner unavailable");
      }
      return { unarchived: 1 };
    });
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("write failed");
    expect(
      bb.storage
        .database()
        .prepare("SELECT thread_id AS threadId FROM snoozes")
        .all(),
    ).toEqual([{ threadId: "thr_child" }]);
    await harness.lifecycle.dispose();
  });

  it("wakes owners before dependents", async () => {
    const { bb, harness, archive, unarchive } = await setup();
    archive.mockResolvedValueOnce({
      archivedThreadIds: ["thr_child", THREAD_ID],
      ok: true,
    });
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage.database().prepare("UPDATE snoozes SET wake_at = 0").run();
    let rootArchived = true;
    unarchive.mockImplementation(async ({ threadId }) => {
      if (threadId === "thr_child" && rootArchived)
        throw new Error("owner is archived");
      if (threadId === THREAD_ID) rootArchived = false;
      return { unarchived: 1 };
    });
    await harness.behavior.runSchedule("snooze-wake");
    expect(unarchive.mock.calls.map(([input]) => input.threadId)).toEqual([
      THREAD_ID,
      "thr_child",
    ]);
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("retains records after an unrelated 404", async () => {
    const { bb, harness, unarchive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = ?")
      .run(THREAD_ID);
    unarchive.mockRejectedValueOnce(new Error("HTTP 404: route missing"));
    await harness.behavior.runSchedule("snooze-wake");
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("rolls back when the post-archive ancestor lookup fails", async () => {
    const { bb, harness, archive, unarchive, experimental_listAncestors } =
      await setup();
    archive.mockResolvedValueOnce({
      archivedThreadIds: ["thr_child", THREAD_ID],
      ok: true,
    });
    experimental_listAncestors.mockResolvedValueOnce({
      threads: [{ threadId: THREAD_ID, ancestorIds: [] }],
    });
    experimental_listAncestors.mockRejectedValueOnce(
      new Error("ancestors unavailable"),
    );
    await expect(
      harness.behavior.callRpc("snooze", { threadId: THREAD_ID }),
    ).rejects.toThrow("ancestors unavailable");
    expect(unarchive.mock.calls.map(([input]) => input.threadId)).toEqual([
      THREAD_ID,
      "thr_child",
    ]);
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("orders wake reconciliation by depth before wake time", async () => {
    const { bb, harness, archive, unarchive } = await setup();
    archive.mockResolvedValueOnce({
      archivedThreadIds: [THREAD_ID, "thr_child"],
      ok: true,
    });
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = 'thr_child'")
      .run();
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 100 WHERE thread_id = ?")
      .run(THREAD_ID);
    let rootArchived = true;
    unarchive.mockImplementation(async ({ threadId }) => {
      if (threadId === "thr_child" && rootArchived)
        throw new Error("owner is archived");
      if (threadId === THREAD_ID) rootArchived = false;
      return { unarchived: 1 };
    });
    await harness.behavior.runSchedule("snooze-wake");
    expect(unarchive.mock.calls.map(([input]) => input.threadId)).toEqual([
      THREAD_ID,
      "thr_child",
    ]);
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("finishes a group wake before applying a replacement Snooze", async () => {
    const { bb, harness, archive, unarchive } = await setup();
    archive.mockResolvedValueOnce({
      archivedThreadIds: [THREAD_ID, "thr_child"],
      ok: true,
    });
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage.database().prepare("UPDATE snoozes SET wake_at = 0").run();
    let finishRootWake: (() => void) | undefined;
    unarchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRootWake = () => resolve({ unarchived: 1 });
        }),
    );
    const waking = harness.behavior.runSchedule("snooze-wake");
    archive.mockResolvedValueOnce({
      archivedThreadIds: [THREAD_ID, "thr_child"],
      ok: true,
    });
    const replacement = harness.behavior.callRpc("snooze", {
      threadId: THREAD_ID,
    });
    await vi.waitFor(() => expect(unarchive).toHaveBeenCalledTimes(1));
    finishRootWake?.();
    await Promise.all([waking, replacement]);
    const methods = harness.inspection.sdk.calls.map((call) => call.path);
    expect(methods.lastIndexOf("threads.unarchive")).toBeLessThan(
      methods.lastIndexOf("threads.archive"),
    );
    expect(unarchive).toHaveBeenCalledTimes(2);
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("drops records for threads that no longer exist", async () => {
    const { bb, harness, unarchive } = await setup();
    await harness.behavior.callRpc("snooze", { threadId: THREAD_ID });
    bb.storage
      .database()
      .prepare("UPDATE snoozes SET wake_at = 0 WHERE thread_id = ?")
      .run(THREAD_ID);
    unarchive.mockRejectedValueOnce(new Error("HTTP 404: thread_not_found"));
    const service = harness.behavior.runService("snooze-startup");
    await service.done;
    expect(
      bb.storage.database().prepare("SELECT * FROM snoozes").all(),
    ).toEqual([]);
    await harness.lifecycle.dispose();
  });
});

describe("package boundaries", () => {
  it("uses only public SDK and package-local imports", async () => {
    const result = await experimental_scanPublicSdkOnly(
      fileURLToPath(new URL(".", import.meta.url)),
      {
        allow: [
          /^vitest(?:\/config)?$/,
          /^@testing-library\//,
          /^@radix-ui\//,
          /^react(?:-dom)?$/,
          /^sonner$/,
          /^(?:class-variance-authority|clsx|tailwind-merge)$/,
          /^@\//,
        ],
      },
    );
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
