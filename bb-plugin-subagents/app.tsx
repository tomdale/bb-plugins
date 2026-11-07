import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SubagentsPanel } from "./src/panel.tsx";
import { SubagentsHeader } from "./src/header.tsx";
import { rowStatusScript } from "./src/row-status.ts";

export default definePluginApp(app => {
  app.slots.threadPanelAction({ id: "subagents", title: "Subagents", icon: "GitFork", layout: "flush", component: SubagentsPanel });
  app.slots.experimental_threadHeaderAction({ id: "subagents", title: "Subagents", component: SubagentsHeader });
  app.contentScripts.register(rowStatusScript);
});
