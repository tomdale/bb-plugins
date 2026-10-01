import { useRpc } from "@get-bb/plugin-sdk/app";
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
import type { rpcContract } from "../contracts.js";
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
