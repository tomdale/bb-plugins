// The Walkthrough thread panel: the starter until a walkthrough exists, then the reader.
import { useState } from "react";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { useWalkthrough } from "./hooks.ts";
import { Skeleton } from "./Pages.tsx";
import { Reader } from "./Reader.tsx";
import { Starter } from "./Starter.tsx";

export { Reader };

export function paneParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const id = (params as Record<string, unknown>).walkthroughId;
  return typeof id === "string" ? id : null;
}

/** A skeleton in the page's own layout while the walkthrough loads, so nothing shifts when it arrives. */
export function LoadingPage({ message }: { message?: string | null }) {
  return (
    <div className="wt">
      <div className="wt-scroll">
        <div className="wt-page">
          <div className="wt-pn" data-bare aria-hidden>
            PART<b>·</b>
          </div>
          {message ? <p className="wt-muted">{message}</p> : <Skeleton label="Opening the walkthrough…" />}
        </div>
      </div>
    </div>
  );
}

export function WalkthroughPane({ threadId, params }: PluginThreadPanelProps) {
  const paramId = paneParams(params);
  // The starter hands its tab to the walkthrough it starts; the tab's own params stay empty.
  const [startedId, setStartedId] = useState<string | null>(null);
  const walkthroughId = paramId ?? startedId;
  const { view, loaded, error, rpc } = useWalkthrough(walkthroughId);
  if (walkthroughId === null) return <Starter threadId={threadId} onOpen={setStartedId} />;
  if (!loaded) return <LoadingPage message={error} />;
  if (view === null) return <LoadingPage message="This walkthrough no longer exists." />;
  return <Reader threadId={threadId} view={view} rpc={rpc} surface="panel" retitle={paramId !== null} />;
}
