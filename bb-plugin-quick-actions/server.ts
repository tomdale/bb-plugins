import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  snooze: {
    input: z.object({ threadId: z.string().min(1).max(200) }).strict(),
    output: z.object({
      threadId: z.string(),
      wakeAt: z.number().int(),
      snoozedThreadIds: z.array(z.string()),
    }),
  },
});

type SnoozeRecord = {
  threadId: string;
  groupId: string;
  generation: string;
  snoozedAt: number;
  wakeAt: number;
  depth: number;
};

export function nextSnoozeWake(now: Date): number {
  const wake = new Date(now);
  wake.setDate(wake.getDate() + 1);
  wake.setHours(9, 0, 0, 0);
  return wake.getTime();
}

function isMissingThreadError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("thread_not_found");
}

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    trigger: {
      type: "select",
      label: "Menu trigger",
      options: ["hold-option", "corner"],
      experimental_optionLabels: {
        "hold-option": "Hold Option at the pointer",
        corner: "Corner button",
      },
      default: "hold-option",
    },
    corner: {
      type: "select",
      label: "Menu corner",
      options: ["bottom-left", "bottom-right", "top-left", "top-right"],
      experimental_optionLabels: {
        "bottom-left": "Bottom left",
        "bottom-right": "Bottom right",
        "top-left": "Top left",
        "top-right": "Top right",
      },
      default: "bottom-left",
    },
    motion: {
      type: "select",
      label: "Menu motion",
      options: ["ring", "arc"],
      experimental_optionLabels: {
        ring: "Ring bloom",
        arc: "Arc spring",
      },
      default: "ring",
    },
    debugRegions: {
      type: "boolean",
      label: "Debug hover regions",
      default: false,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS snoozes (
      thread_id TEXT PRIMARY KEY,
      wake_at INTEGER NOT NULL
    )`,
    `ALTER TABLE snoozes ADD COLUMN generation TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE snoozes ADD COLUMN snoozed_at INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE snoozes ADD COLUMN group_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE snoozes ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`,
  ]);

  const readSnooze = db.prepare<[string], SnoozeRecord>(
    "SELECT thread_id AS threadId, group_id AS groupId, generation, snoozed_at AS snoozedAt, wake_at AS wakeAt, depth FROM snoozes WHERE thread_id = ?",
  );
  const readGroupSnoozes = db.prepare<[string], SnoozeRecord>(
    "SELECT thread_id AS threadId, group_id AS groupId, generation, snoozed_at AS snoozedAt, wake_at AS wakeAt, depth FROM snoozes WHERE group_id = ?",
  );
  const writeSnooze = db.prepare(
    `INSERT INTO snoozes (thread_id, group_id, generation, snoozed_at, wake_at, depth) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       group_id = excluded.group_id,
       generation = excluded.generation,
       snoozed_at = excluded.snoozed_at,
       wake_at = excluded.wake_at,
       depth = excluded.depth`,
  );
  const deleteSnooze = db.prepare(
    "DELETE FROM snoozes WHERE thread_id = ? AND generation = ?",
  );
  const deleteAnySnooze = db.prepare("DELETE FROM snoozes WHERE thread_id = ?");
  const dueSnoozes = db.prepare<[number], SnoozeRecord>(
    "SELECT thread_id AS threadId, group_id AS groupId, generation, snoozed_at AS snoozedAt, wake_at AS wakeAt, depth FROM snoozes WHERE wake_at <= ? ORDER BY depth, wake_at, thread_id",
  );
  const writeSnoozes = db.transaction((records: readonly SnoozeRecord[]) => {
    for (const record of records) {
      writeSnooze.run(
        record.threadId,
        record.groupId,
        record.generation,
        record.snoozedAt,
        record.wakeAt,
        record.depth,
      );
    }
  });
  const deleteSnoozes = db.transaction((records: readonly SnoozeRecord[]) => {
    for (const record of records) {
      deleteSnooze.run(record.threadId, record.generation);
    }
  });

  let mutationQueue = Promise.resolve();
  const rollbackEventSuppressions = new Map<string, number>();

  function changeRollbackSuppression(threadId: string, delta: 1 | -1): void {
    const next = (rollbackEventSuppressions.get(threadId) ?? 0) + delta;
    if (next <= 0) rollbackEventSuppressions.delete(threadId);
    else rollbackEventSuppressions.set(threadId, next);
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(work, work);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function snoozeThread(threadId: string) {
    return enqueue(async () => {
      const previousRoot = readSnooze.get(threadId);
      const previousGroup = previousRoot?.groupId
        ? readGroupSnoozes.all(previousRoot.groupId)
        : previousRoot
          ? [previousRoot]
          : [];
      const groupId = previousRoot?.groupId || randomUUID();
      const generation = randomUUID();
      const cascade = await bb.sdk.threads.experimental_listCascade({
        threadIds: [threadId],
        action: "archive",
      });
      const intendedIds = [
        ...new Set([
          threadId,
          ...previousGroup.map((record) => record.threadId),
          ...(cascade.threads[0]?.cascadeThreadIds ?? [threadId]),
        ]),
      ];
      const previousById = new Map<string, SnoozeRecord>();
      for (const record of previousGroup)
        previousById.set(record.threadId, record);
      for (const id of intendedIds) {
        const previous = readSnooze.get(id);
        if (previous) previousById.set(id, previous);
      }
      const preArchiveStates = new Map<string, number | null>();
      for (const id of intendedIds) {
        const current = await bb.sdk.threads.get({ threadId: id });
        preArchiveStates.set(id, current.archivedAt);
      }

      const ancestors = await bb.sdk.threads.experimental_listAncestors({
        threadIds: intendedIds,
      });
      const depthById = new Map<string, number>();
      for (const entry of ancestors.threads) {
        depthById.set(entry.threadId, entry.ancestorIds.length);
      }
      const snoozedAt = Date.now();
      const wakeAt = nextSnoozeWake(new Date(snoozedAt));
      const makeRecord = (id: string): SnoozeRecord => ({
        threadId: id,
        groupId,
        generation,
        snoozedAt,
        wakeAt,
        depth: depthById.get(id) ?? 0,
      });
      const intendedRecords = intendedIds.map(makeRecord);
      writeSnoozes(intendedRecords);

      let archived: { archivedThreadIds: string[] };
      try {
        archived = await bb.sdk.threads.archive({ threadId });
      } catch (cause) {
        const states = new Map<string, number | null>();
        let verificationFailed = false;
        for (const id of intendedIds) {
          try {
            const current = await bb.sdk.threads.get({ threadId: id });
            states.set(id, current.archivedAt);
          } catch {
            verificationFailed = true;
            break;
          }
        }
        if (verificationFailed) throw cause;
        const allArchived = intendedIds.every((id) => states.get(id) !== null);
        const newlyArchived = intendedIds.some(
          (id) => preArchiveStates.get(id) === null && states.get(id) !== null,
        );
        const noMutationNeeded = intendedIds.every(
          (id) => preArchiveStates.get(id) !== null,
        );
        if (allArchived && (newlyArchived || noMutationNeeded)) {
          return { threadId, wakeAt, snoozedThreadIds: intendedIds };
        }
        if (newlyArchived) throw cause;
        deleteSnoozes(intendedRecords);
        writeSnoozes([...previousById.values()]);
        throw cause;
      }

      const finalIds = [
        ...new Set([...intendedIds, ...archived.archivedThreadIds]),
      ];
      for (const id of archived.archivedThreadIds) {
        if (previousById.has(id) || intendedIds.includes(id)) continue;
        const previous = readSnooze.get(id);
        if (previous) previousById.set(id, previous);
      }
      let finalRecords = finalIds.map(makeRecord);
      try {
        const finalAncestors = await bb.sdk.threads.experimental_listAncestors({
          threadIds: finalIds,
        });
        for (const entry of finalAncestors.threads) {
          depthById.set(entry.threadId, entry.ancestorIds.length);
        }
        finalRecords = finalIds.map(makeRecord);
        writeSnoozes(finalRecords);
      } catch (cause) {
        const rollbackFailed = new Set<string>();
        for (const id of [...archived.archivedThreadIds].sort((a, b) => {
          const aKnown = depthById.has(a);
          const bKnown = depthById.has(b);
          if (aKnown !== bKnown) return aKnown ? -1 : 1;
          return (
            (depthById.get(a) ?? 0) - (depthById.get(b) ?? 0) ||
            a.localeCompare(b)
          );
        })) {
          changeRollbackSuppression(id, 1);
          try {
            await bb.sdk.threads.unarchive({ threadId: id });
          } catch (rollbackCause) {
            changeRollbackSuppression(id, -1);
            rollbackFailed.add(id);
            bb.log.warn(
              `Could not roll back archive for ${id}: ${
                rollbackCause instanceof Error
                  ? rollbackCause.message
                  : String(rollbackCause)
              }`,
            );
          }
        }
        deleteSnoozes(
          finalRecords.filter((record) => !rollbackFailed.has(record.threadId)),
        );
        writeSnoozes(
          [...previousById.values()].filter(
            (record) => !rollbackFailed.has(record.threadId),
          ),
        );
        if (rollbackFailed.size > 0) {
          try {
            writeSnoozes(
              finalRecords.filter((record) =>
                rollbackFailed.has(record.threadId),
              ),
            );
          } catch (recoveryCause) {
            bb.log.error(
              `Could not preserve Snooze after rollback failure: ${
                recoveryCause instanceof Error
                  ? recoveryCause.message
                  : String(recoveryCause)
              }`,
            );
            throw recoveryCause;
          }
        }
        throw cause;
      }
      return { threadId, wakeAt, snoozedThreadIds: finalIds };
    });
  }

  async function wakeDueSnoozes(): Promise<void> {
    const due = dueSnoozes.all(Date.now());
    await enqueue(async () => {
      for (const record of due) {
        const current = readSnooze.get(record.threadId);
        if (
          !current ||
          current.generation !== record.generation ||
          current.wakeAt > Date.now()
        ) {
          continue;
        }
        try {
          await bb.sdk.threads.unarchive({ threadId: record.threadId });
          deleteSnooze.run(record.threadId, record.generation);
        } catch (cause) {
          if (isMissingThreadError(cause)) {
            deleteSnooze.run(record.threadId, record.generation);
            continue;
          }
          bb.log.warn(
            `Could not wake snoozed thread ${record.threadId}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
    });
  }

  bb.rpc.register(rpcContract, {
    snooze: async ({ threadId }) => snoozeThread(threadId),
  });

  bb.events.on("thread.unarchived", ({ thread }) => {
    void enqueue(async () => {
      if (thread.archivedAt !== null) return;
      if ((rollbackEventSuppressions.get(thread.id) ?? 0) > 0) {
        changeRollbackSuppression(thread.id, -1);
        return;
      }
      const current = await bb.sdk.threads.get({ threadId: thread.id });
      if (current.archivedAt !== null) return;
      if (readSnooze.get(thread.id)) deleteAnySnooze.run(thread.id);
    }).catch((cause) => {
      bb.log.warn(
        `Could not cancel snooze for ${thread.id}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    void enqueue(async () => {
      deleteAnySnooze.run(thread.id);
    }).catch((cause) => {
      bb.log.warn(
        `Could not remove deleted thread ${thread.id} from Snooze: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });
  });

  bb.background.service("snooze-startup", {
    async start() {
      await wakeDueSnoozes();
    },
  });
  bb.background.schedule("snooze-wake", "* * * * *", wakeDueSnoozes);
}
