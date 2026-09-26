import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { WorkforestPage } from "./ui/page.js";
import { ThreadPanel, ThreadHeader, Homepage } from "./ui/thread-surfaces.js";

export default definePluginApp((app) => {
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
  app.slots.homepageSection({
    id: "workforest",
    title: "Workforest",
    component: Homepage,
  });
});
