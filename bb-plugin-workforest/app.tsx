import { useEffect, useState } from "react";
import {
  definePluginApp,
  type JsonValue,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { WorkforestPage } from "./ui/page.js";
import { WorkforestProjectButton } from "./ui/composer-project.js";
import { WORKFOREST_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Template } from "./contracts.js";
import { ThreadPanel, ThreadHeader, Homepage } from "./ui/thread-surfaces.js";

function WorkforestInputs({
  value,
  onChange,
  target,
}: PluginEnvironmentProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [inventory, setInventory] = useState<
    { selector: string; path: string; type: string }[]
  >([]);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [source, setSource] = useState("@vercel-agent");
  const [name, setName] = useState("");
  const [selector, setSelector] = useState("");
  const hostId = target.kind === "existing-host" ? target.hostId : null;

  useEffect(() => {
    if (!hostId) return;
    void Promise.all([
      rpc.call("templates", { hostId }),
      rpc.call("inventory", { hostId }),
    ]).then(([nextTemplates, nextInventory]) => {
      setTemplates(nextTemplates);
      setInventory([
        ...nextInventory.workspaces,
        ...nextInventory.repositories,
      ]);
    });
  }, [hostId]);

  useEffect(() => {
    let next: JsonValue | null = null;
    if (mode === "new" && source && name) next = { mode, source, name };
    if (mode === "existing" && selector) {
      const entry = inventory.find(
        (candidate) => candidate.selector === selector,
      );
      if (entry) next = { mode, selector, path: entry.path };
    }
    onChange(
      next
        ? { status: "ready", value: next }
        : {
            status: "blocked",
            reason:
              mode === "new"
                ? "Choose a source and workspace name."
                : "Choose an existing Workforest checkout.",
          },
    );
  }, [mode, source, name, selector, inventory]);

  return (
    <div className="space-y-2">
      <select
        value={mode}
        onChange={(event) => setMode(event.target.value as "new" | "existing")}
      >
        <option value="new">Create new workspace</option>
        <option value="existing">Use existing checkout</option>
      </select>
      {mode === "new" ? (
        <>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            {templates.map((template) => (
              <option key={template.id} value={`@${template.id}`}>
                Template: @{template.id}
              </option>
            ))}
            <option value="">Repository…</option>
          </select>
          {!source.startsWith("@") && (
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="owner/repository"
            />
          )}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="workspace name"
          />
        </>
      ) : (
        <select
          value={selector}
          onChange={(event) => setSelector(event.target.value)}
        >
          <option value="">Select checkout…</option>
          {inventory.map((entry) => (
            <option key={entry.selector} value={entry.selector}>
              {entry.selector}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "workforest-project",
    scopes: ["new-thread"],
    actions: [{ id: "picker", component: WorkforestProjectButton }],
  });
  app.slots.navPanel({
    id: "workspaces",
    title: "Workforest",
    icon: "GitBranch",
    path: "workspaces",
    component: WorkforestPage,
  });
  app.slots.threadPanelAction({
    id: "workspace",
    title: "Workforest workspace",
    icon: "GitBranch",
    component: ThreadPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "workspace-status",
    title: "Workforest",
    component: ThreadHeader,
  });
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: WORKFOREST_ENVIRONMENT_PROVIDER_ID,
    component: WorkforestInputs,
  });
  app.slots.homepageSection({
    id: "workforest",
    title: "Workforest",
    component: Homepage,
  });
});
