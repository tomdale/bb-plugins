import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useState, type FormEvent } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import type { Bootstrap, Checkout, rpcContract } from "../contracts.js";
import { useResource } from "../hooks/use-resource.js";
import { ErrorMessage, muted, selectClass } from "./shared.js";
export function CreateDialog({
  hostId,
  close,
}: {
  hostId: string;
  close: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const templates = useResource(
    `templates:${hostId}`,
    () => rpc.call("templates", { hostId }),
    0,
  );
  const [mode, setMode] = useState("repositories");
  const [sources, setSources] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await rpc.call("start", {
        hostId,
        operation: {
          kind: "create",
          name,
          sources:
            mode === "template" ? [`@${sources}`] : sources.trim().split(/\s+/),
        },
      });
      close();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start isolated work</DialogTitle>
          <DialogDescription>
            One repository creates a worktree. Multiple repositories or a
            template create a workspace. Workforest uses your configured branch
            prefix and setup hooks.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="grid gap-2 text-sm">
            Change name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="fix-auth-flow"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxLength={80}
              required
            />
          </label>
          <label className="grid gap-2 text-sm">
            Start from
            <select
              className={selectClass}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value);
                setSources("");
              }}
            >
              <option value="repositories">Repositories</option>
              <option value="template">Workforest template</option>
            </select>
          </label>
          {mode === "template" ? (
            <label className="grid gap-2 text-sm">
              Template
              <select
                className={selectClass}
                value={sources}
                onChange={(event) => setSources(event.target.value)}
                required
              >
                <option value="">Choose a template</option>
                {templates.data?.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.id} · {template.repositories.length} repos
                  </option>
                ))}
              </select>
              <span className={muted}>
                {
                  templates.data?.find((template) => template.id === sources)
                    ?.config.description
                }
              </span>
              <ErrorMessage message={templates.error} />
            </label>
          ) : (
            <label className="grid gap-2 text-sm">
              Repositories
              <Input
                value={sources}
                onChange={(event) => setSources(event.target.value)}
                placeholder="owner/web owner/api"
                required
              />
              <span className={muted}>
                Space-separated owner/repository names.
              </span>
            </label>
          )}
          <ErrorMessage message={error} />
          <Button type="submit" disabled={pending || !sources || !name}>
            {pending ? "Starting…" : "Create checkout"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LaunchDialog({
  target,
  bootstrap,
  close,
}: {
  target: Checkout;
  bootstrap: Bootstrap;
  close: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const matching = bootstrap.projects.find((project) =>
    project.sources.some(
      (source) =>
        source.hostId === target.hostId && source.path === target.path,
    ),
  );
  const [projectId, setProjectId] = useState(matching?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const project = await rpc.call("connect", {
        ...target,
        projectId: projectId || null,
      });
      setProjectId(project.projectId);
      const thread = await rpc.call("launch", {
        ...target,
        projectId: project.projectId,
        prompt,
      });
      close();
      navigate.toThread(thread.threadId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a BB thread</DialogTitle>
          <DialogDescription>
            Uses this exact Workforest checkout as a direct BB environment, with
            the selected project's default provider, model, and permissions. No
            new Git worktree is created.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <p className="break-all rounded bg-muted p-2 font-mono text-xs">
            {target.path}
          </p>
          <label className="grid gap-2 text-sm">
            BB project
            <select
              className={selectClass}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">
                Create / reuse a project for this checkout
              </option>
              {bootstrap.projects
                .filter((project) =>
                  project.sources.some(
                    (source) => source.hostId === target.hostId,
                  ),
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              {projectId &&
                !bootstrap.projects.some(
                  (project) => project.id === projectId,
                ) && <option value={projectId}>New checkout project</option>}
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            What should the agent do?
            <textarea
              className="min-h-28 rounded-md border border-input bg-background p-3 text-sm"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              required
              maxLength={100000}
              placeholder="Describe the work for this checkout…"
            />
          </label>
          <ErrorMessage message={error} />
          <Button type="submit" disabled={pending || !prompt.trim()}>
            {pending ? "Starting thread…" : "Start thread"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TaskDialog({
  hostId,
  selector,
  repository,
  close,
}: {
  hostId: string;
  selector: string;
  repository: string;
  close: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState("");
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await rpc.call("start", {
        hostId,
        operation: { kind: "task", selector, repository, name, setup },
      });
      close();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task lane in {repository}</DialogTitle>
          <DialogDescription>
            Branches from the parent's committed HEAD. Workforest refuses dirty
            parents. This creates a checkout, not an agent.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <label className="grid gap-2 text-sm">
            Task name
            <Input
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="add-tests"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={setup}
              onChange={(event) => setSetup(event.target.checked)}
            />
            Run dependency / environment setup
          </label>
          <ErrorMessage message={error} />
          <Button type="submit" disabled={pending || !name}>
            {pending ? "Creating…" : "Create task lane"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
