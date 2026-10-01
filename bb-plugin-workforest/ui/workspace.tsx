import {
  experimental_useSidebarThreads,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Icon } from "../components/ui/icon.js";
import type { Bootstrap, Detail, Preview, rpcContract } from "../contracts.js";
import { useResource } from "../hooks/use-resource.js";
import { TaskDialog } from "./dialogs.js";
import { Empty, ErrorMessage, State, muted } from "./shared.js";
export function WorkspaceDetail({
  hostId,
  selector,
  bootstrap,
}: {
  hostId: string;
  selector: string;
  bootstrap: Bootstrap;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const detail = useResource(`detail:${hostId}:${selector}`, () =>
    rpc.call("detail", { hostId, selector }),
  );
  const [task, setTask] = useState<string>();
  const [logs, setLogs] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function perform(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await action();
      detail.refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold">{selector}</h2>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {detail.data?.path}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Refresh workspace"
          onClick={detail.refresh}
        >
          <Icon name="RotateCcw" className="size-4" />
        </Button>
      </div>
      <ErrorMessage message={detail.error || error} />
      {!detail.data ? (
        <Empty>
          {detail.error
            ? "Workspace status is unavailable. Check the error above, then refresh."
            : "Loading repository status…"}
        </Empty>
      ) : (
        <>
          <div className="space-y-3">
            {detail.data.repositories.map((repo) => (
              <div
                key={repo.path}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium">{repo.name}</h3>
                  <State value={repo.state} />
                </div>
                <p className="my-2 break-all font-mono text-xs text-muted-foreground">
                  {repo.branch ?? "detached HEAD"}
                </p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{repo.dirty.total} changed</span>
                  <span>
                    ↑ {repo.ahead ?? "?"} ↓ {repo.behind ?? "?"}
                  </span>
                  <span>
                    {repo.integrated === true
                      ? "Integrated"
                      : repo.integrated === false
                        ? "Not integrated"
                        : "Integration unknown"}
                  </span>
                </div>
                {repo.setup && (
                  <div className="mt-2 space-y-1">
                    <State value={`setup ${repo.setup.status}`} />
                    <p className="break-words text-xs text-muted-foreground">
                      {repo.setup.message ?? repo.setup.step}
                    </p>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => open(repo.path)}
                  >
                    Thread in {repo.name}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setTask(repo.name)}
                    disabled={repo.dirty.total > 0}
                  >
                    New task lane
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {detail.data.tasks.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Task lanes</h3>
              {detail.data.tasks.map((task) => (
                <div
                  key={task.path}
                  className="flex items-center justify-between gap-2 rounded-md border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {task.parentRepo} / {task.slug}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {task.state} · {task.merged ? "merged" : "unmerged"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => open(task.path)}
                  >
                    Open
                  </Button>
                </div>
              ))}
            </div>
          )}
          <LinkedThreads hostId={hostId} detail={detail.data} />
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void perform(async () =>
                  setLogs((await rpc.call("logs", { hostId, selector })).text),
                )
              }
            >
              Setup logs
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void perform(() =>
                  rpc.call("start", {
                    hostId,
                    operation: { kind: "retry", selector },
                  }),
                )
              }
            >
              Retry setup
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void perform(() =>
                  rpc.call("preview", { hostId, selector }).then(setPreview),
                )
              }
            >
              Check cleanup safety
            </Button>
          </div>
        </>
      )}
      {task && (
        <TaskDialog
          hostId={hostId}
          selector={selector}
          repository={task}
          close={() => {
            setTask(undefined);
            detail.refresh();
          }}
        />
      )}
      {logs !== undefined && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setLogs(undefined);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Setup logs</DialogTitle>
              <DialogDescription>
                {selector} · last 24,000 characters; logs may contain output
                from your setup scripts.
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
              {logs || "No recorded setup output."}
            </pre>
          </DialogContent>
        </Dialog>
      )}
      {preview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(undefined);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {preview.blocked
                  ? "Cleanup is blocked"
                  : "Workforest checks passed"}
              </DialogTitle>
              <DialogDescription>
                Preview only. No checkout, branch, BB project, or thread has
                been deleted.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {preview.blockers.map((blocker, i) => (
                <div key={i}>
                  <p className="text-sm text-destructive">{blocker.message}</p>
                  <p className="break-all font-mono text-xs">
                    {blocker.suggestion}
                  </p>
                </div>
              ))}
              <p className={muted}>
                Stop agents using this checkout and review linked BB threads
                before cleanup. For intentional deletion, run on the selected
                machine:
              </p>
              <code className="block break-all rounded bg-muted p-2 text-xs">
                wf delete {selector}
              </code>
              <p className="text-xs text-muted-foreground">
                Workforest rechecks clean/integrated repositories and nested
                tasks. BB references are not removed automatically.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

export function LinkedThreads({
  hostId,
  detail,
}: {
  hostId: string;
  detail: Detail;
}) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  // Sidebar data exposes environment identities, not paths; do not infer checkout ownership from a branch name.
  const rpc = useRpc<typeof rpcContract>();
  const candidates = sidebar.threads
    .filter((thread) => thread.host?.id === hostId)
    .slice(0, 100);
  const ids = candidates.map((thread) => thread.id).join(",");
  const linked = useResource(
    `linked:${hostId}:${detail.selector}:${ids}`,
    async () => {
      const matched: string[] = [];
      for (let i = 0; i < candidates.length; i += 5) {
        const batch = await Promise.all(
          candidates.slice(i, i + 5).map(async (thread) => {
            const context = await rpc.call("context", { threadId: thread.id });
            return context?.entry?.selector === detail.selector
              ? thread.id
              : null;
          }),
        );
        matched.push(...batch.filter((id): id is string => id !== null));
      }
      return matched;
    },
    30000,
  );
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">BB threads</h3>
      <ErrorMessage message={linked.error} />
      {linked.data?.length ? (
        linked.data.map((id) => (
          <Button
            key={id}
            variant="ghost"
            className="h-auto w-full justify-start whitespace-normal text-left"
            onClick={() => navigate.toThread(id)}
          >
            <Icon name="MessageSquare" className="size-4 shrink-0" />
            {candidates.find((thread) => thread.id === id)?.title ?? id}
          </Button>
        ))
      ) : (
        <p className={muted}>
          {linked.data
            ? "No linked threads in the current sidebar."
            : "Checking thread environments…"}
        </p>
      )}
      {candidates.length === 100 && (
        <p className="text-xs text-muted-foreground">
          Showing matches among the first 100 threads on this machine.
        </p>
      )}
    </div>
  );
}
