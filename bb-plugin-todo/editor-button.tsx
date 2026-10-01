import { useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";

export function TodoEditorButton({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return <button type="button" aria-label="Open Todos" title="Open Todos"
    onClick={() => navigate.openThreadPanel({ actionId: "todos" })}>
    {isCompactViewport ? "☑" : "Todos"}
  </button>;
}
