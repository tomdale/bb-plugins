import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SubagentsPanel } from "./src/panel.tsx";
import { subagentsReturnControlAction, subagentsStatusAction } from "./src/header-actions.ts";
import { rowStatusScript } from "./src/row-status.ts";

export default definePluginApp(app => {
  // An action tab: it joins the thread panel's action list and opens a
  // closable instance per thread, so the run list stays beside the thread.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "subagents",
    title: "Subagents",
    icon: "GitFork",
    layout: "flush",
    component: SubagentsPanel,
  });
  app.slots.experimental_threadAction(subagentsStatusAction);
  app.slots.experimental_threadAction(subagentsReturnControlAction);
  app.contentScripts.register(rowStatusScript);
});
