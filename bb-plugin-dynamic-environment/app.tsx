import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk";
import type { contract, DynamicState, StaticState } from "./src/contract.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import "./app.css";

type Rpc = PluginRpcClient<typeof contract>;
type Editor = {
  originalName: string | null;
  name: string;
  text: string;
  replace: boolean;
};

function EnvironmentSection({ mode }: { mode: "dynamic" | "static" }) {
  const rpc = useRpc<typeof contract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const dynamic = mode === "dynamic";
  const [state, setState] = useState<DynamicState | StaticState | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showValue, setShowValue] = useState(false);
  const load = (client: Rpc) =>
    dynamic ? client.call("dynamicList", {}) : client.call("staticList", {});

  useEffect(() => {
    let active = true;
    void load(rpcRef.current)
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => {
        if (active)
          setError("Could not load variables. Retry using Reload list.");
      });
    return () => {
      active = false;
    };
  }, [mode]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not update variables.",
      );
    } finally {
      setBusy(false);
    }
  }
  function startEdit(name: string | null) {
    setError(null);
    setNotice(null);
    setDeleting(null);
    setShowValue(false);
    setEditor({
      originalName: name,
      name: name ?? "",
      text:
        state && "entries" in state
          ? (state.entries.find((entry) => entry.name === name)?.command ?? "")
          : "",
      replace: name === null,
    });
  }
  async function save() {
    if (!state || !editor) return;
    const next = dynamic
      ? await rpc.call("dynamicSave", {
          originalName: editor.originalName,
          entry: { name: editor.name, command: editor.text },
          revision: state.revision,
        })
      : await rpc.call("staticSave", {
          originalName: editor.originalName,
          name: editor.name,
          value: editor.replace ? editor.text : null,
          revision: state.revision,
        });
    setState(next);
    setEditor(null);
    setShowValue(false);
    setNotice(
      dynamic
        ? "Saved. The command will run when a new provider child environment is resolved."
        : "Saved to env.json. Reload BB configuration to apply changes; already-running processes may need restarting.",
    );
  }
  async function remove(name: string) {
    if (!state) return;
    const next = dynamic
      ? await rpc.call("dynamicRemove", { name, revision: state.revision })
      : await rpc.call("staticRemove", { name, revision: state.revision });
    setState(next);
    setDeleting(null);
    setNotice(
      dynamic
        ? "Variable removed. Existing processes keep their inherited values."
        : "Removed from env.json. Reload configuration; existing processes keep inherited values until restarted.",
    );
  }
  const names =
    state === null
      ? []
      : "entries" in state
        ? state.entries.map((entry) => entry.name)
        : state.names;
  return (
    <section
      className="env-section space-y-4"
      aria-label={dynamic ? "Dynamic variables" : "Static variables"}
    >
      <div className="space-y-2 text-sm text-muted-foreground">
        {dynamic ? (
          <>
            <p>
              Run a trusted local command and use its output as an environment
              variable for Codex, Claude Code and Pi. Resolved values are not
              stored.
            </p>
            <p>
              Commands execute on the BB server with your permissions when a
              provider child environment is resolved. Use commands that retrieve
              secrets, not commands containing secrets.
            </p>
          </>
        ) : (
          <>
            <p>
              Edit the BB server’s <code>env.json</code>. Values are stored as
              plaintext on disk, but saved values are never returned to this
              page. Prefer a dynamic command for Keychain or password-manager
              secrets.
            </p>
            {state && "path" in state && (
              <p className="break-all font-mono text-xs">{state.path}</p>
            )}
            <p>
              Changes do not modify macOS launchd or running processes. After
              saving, reload BB configuration; some changes require restarting
              BB or the affected provider.
            </p>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !state || editor !== null || deleting !== null}
          onClick={() => startEdit(null)}
        >
          Add {dynamic ? "dynamic" : "static"} variable
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || editor !== null || deleting !== null}
          onClick={() =>
            void run(async () => {
              setState(await load(rpc));
            })
          }
        >
          Reload list
        </Button>
        {!dynamic && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || editor !== null || deleting !== null}
            onClick={() =>
              void run(async () => {
                await rpc.call("reloadConfig", {});
                setNotice(
                  "BB configuration reloaded. Restart affected processes if they still have old values.",
                );
              })
            }
          >
            Reload BB configuration
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {!state && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading variables…
        </p>
      )}
      {state && names.length === 0 && !editor && (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No {dynamic ? "dynamic" : "static"} variables configured.
        </p>
      )}
      {names.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {names.map((name) => (
            <li key={name} className="space-y-3 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="break-all font-mono text-sm font-medium">
                    {name}
                  </p>
                  <p className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                    {state && "entries" in state
                      ? state.entries.find((entry) => entry.name === name)
                          ?.command
                      : "Value saved · hidden"}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Edit ${name}`}
                    disabled={busy || editor !== null || deleting !== null}
                    onClick={() => startEdit(name)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    disabled={busy || editor !== null || deleting !== null}
                    onClick={() => {
                      setDeleting(name);
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              {deleting === name && (
                <div
                  className="flex flex-wrap items-center gap-2"
                  role="group"
                  aria-label={`Confirm removal of ${name}`}
                >
                  <p className="w-full text-sm">
                    Remove <code>{name}</code>? This cannot be undone here.
                  </p>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void run(() => remove(name))}
                  >
                    Confirm removal
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDeleting(null)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editor && (
        <form
          className="space-y-4 rounded-md border border-border p-4"
          aria-label={
            editor.originalName === null
              ? "Add variable"
              : `Edit ${editor.originalName}`
          }
          onSubmit={(event) => {
            event.preventDefault();
            void run(save);
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <label className="block space-y-2 text-sm font-medium">
              Variable name
              <Input
                autoFocus
                required
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                maxLength={128}
                spellCheck={false}
                autoCapitalize="none"
                value={editor.name}
                placeholder="MY_VARIABLE"
                onChange={(event) =>
                  setEditor({ ...editor, name: event.target.value })
                }
              />
            </label>
            {dynamic ? (
              <label className="block space-y-2 text-sm font-medium">
                Command
                <textarea
                  className="env-textarea font-mono"
                  required
                  maxLength={16384}
                  rows={3}
                  spellCheck={false}
                  value={editor.text}
                  placeholder="/usr/bin/security find-generic-password … -w"
                  onChange={(event) =>
                    setEditor({ ...editor, text: event.target.value })
                  }
                />
              </label>
            ) : (
              <div className="space-y-3">
                {editor.originalName !== null && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editor.replace}
                      onChange={(event) => {
                        setEditor({
                          ...editor,
                          replace: event.target.checked,
                          text: "",
                        });
                        setShowValue(false);
                      }}
                    />
                    Replace saved value
                  </label>
                )}
                {editor.replace ? (
                  <>
                    <label className="block space-y-2 text-sm font-medium">
                      Value
                      <Input
                        type={showValue ? "text" : "password"}
                        autoComplete="new-password"
                        spellCheck={false}
                        autoCapitalize="none"
                        maxLength={131072}
                        value={editor.text}
                        onChange={(event) =>
                          setEditor({ ...editor, text: event.target.value })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={showValue}
                        onChange={(event) => setShowValue(event.target.checked)}
                      />
                      Show new value
                    </label>
                    <p className="text-xs text-muted-foreground">
                      An empty value saves an empty string. Spaces are
                      preserved.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    The saved value will be kept, including when renaming this
                    variable.
                  </p>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                {busy ? "Saving…" : "Save variable"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditor(null);
                  setShowValue(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "dynamic",
    title: "Dynamic variables",
    component: () => <EnvironmentSection mode="dynamic" />,
  });
  app.slots.settingsSection({
    id: "static",
    title: "Static variables · env.json",
    component: () => <EnvironmentSection mode="static" />,
  });
});
