import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_saveFile,
  ThreadChat,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { captureThread, exportSubtitle } from "@/lib/capture-thread";
import { exportFileName } from "@/lib/file-name";
import { loadOlderMessages, waitForStableTree } from "@/lib/transcript-stage";

/** Reading width of the exported page; the snapshot is laid out at this width. */
const CAPTURE_WIDTH_PX = 820;
const TRANSCRIPT_MOUNT_TIMEOUT_MS = 15_000;

interface ThreadMeta {
  title: string;
  projectName: string | null;
}

const EMPTY_META: ThreadMeta = { title: "", projectName: null };

type Phase =
  | { kind: "loading"; note: string }
  | { kind: "ready"; html: string; fileName: string; bytes: number; truncated: boolean }
  | { kind: "failed"; message: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for ThreadChat to put bb's transcript on the page, then hands it over. */
async function waitForTranscript(
  stage: HTMLElement,
  isCancelled: () => boolean,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + TRANSCRIPT_MOUNT_TIMEOUT_MS;
  while (Date.now() < deadline && !isCancelled()) {
    const root = stage.querySelector<HTMLElement>("[data-thread-window]");
    if (root !== null && root.querySelector("*") !== null) return root;
    await sleep(100);
  }
  return null;
}

/**
 * The export surface: it renders the thread through bb's own chat component
 * offscreen, snapshots that, and shows the saved page as its preview.
 */
export function ExportPanel({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef<ThreadMeta>(EMPTY_META);
  const [phase, setPhase] = useState<Phase>({ kind: "loading", note: "Rendering the thread…" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const thread = await sdk.threads.get({ threadId });
        const projectName =
          thread.projectId === null || thread.projectId === undefined            ? null
            : await sdk.projects
                .get({ projectId: thread.projectId })
                .then((project) => project.name)
                .catch(() => null);
        if (!live) return;
        const next: ThreadMeta = {
          title: thread.title ?? "",
          projectName,
        };
        metaRef.current = next;
      } catch {
        // A missing title costs the export its heading, not the transcript.
      }
    })();
    return () => {
      live = false;
    };
  }, [sdk, threadId]);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    setPhase({ kind: "loading", note: "Rendering the thread…" });
    void (async () => {
      const stage = stageRef.current;
      if (stage === null) throw new Error("The export surface did not mount.");
      const root = await waitForTranscript(stage, isCancelled);
      if (cancelled) return;
      if (root === null) {
        throw new Error("bb did not finish rendering this thread. Try again.");
      }

      setPhase({ kind: "loading", note: "Loading the whole transcript…" });
      const { exhausted, rounds } = await loadOlderMessages(root, {
        isCancelled,
        onProgress: (pages) => {
          if (!cancelled) {
            setPhase({ kind: "loading", note: `Loading thread history… (${pages})` });
          }
        },
      });
      if (cancelled) return;
      // Leaving rows mid-commit would capture half-drawn markup.
      await waitForStableTree(root);
      if (cancelled) return;

      setPhase({ kind: "loading", note: "Building the page…" });
      const name = metaRef.current;
      const { html } = await captureThread({
        root,
        title: name.title.trim() || "bb thread",
        subtitle: exportSubtitle({
          projectName: name.projectName,
          capturedAt: new Date(),
        }),
      });
      if (cancelled) return;
      setPhase({
        kind: "ready",
        html,
        fileName: exportFileName(name.title, threadId),
        bytes: new Blob([html]).size,
        truncated: !exhausted && rounds > 0,
      });
    })().catch((error: unknown) => {
      if (cancelled) return;
      setPhase({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [threadId, attempt]);

  const save = useCallback(() => {
    if (phase.kind !== "ready") return;
    void experimental_saveFile({
      fileName: phase.fileName,
      blob: new Blob([phase.html], { type: "text/html" }),
    });
  }, [phase]);

  const note =
    phase.kind === "ready"
      ? `${phase.fileName} · ${formatBytes(phase.bytes)}${phase.truncated ? " · older messages could not all be loaded" : ""}`
      : phase.kind === "failed"
        ? phase.message
        : phase.note;

  return (
    <div className="te-panel">
      <div className="te-bar">
        <div className="te-bar-copy">
          <p className="te-bar-title">Share this thread as a page</p>
          <p className="te-bar-note" role="status">
            {note}
          </p>
        </div>
        <div className="te-bar-actions">
          {phase.kind === "ready" ? (
            <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              Rebuild
            </Button>
          ) : null}
          <Button size="sm" onClick={save} disabled={phase.kind !== "ready"}>
            <Icon name="Download" />
            Save page
          </Button>
        </div>
      </div>
      <div className="te-body">
        {phase.kind === "ready" ? (
          <iframe
            className="te-preview"
            title="Preview of the exported page"
            srcDoc={phase.html}
            sandbox=""
          />
        ) : (
          <div className="te-placeholder">
            {phase.kind === "failed" ? (
              <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {/*
        The transcript is laid out off-screen at the export's own reading width,
        so the snapshot does not inherit this panel's narrower column.
      */}
      <div ref={stageRef} className="te-stage" aria-hidden="true" style={{ width: CAPTURE_WIDTH_PX }}>
        <ThreadChat threadId={threadId} variant="timeline" layout="document" />
      </div>
    </div>
  );
}
