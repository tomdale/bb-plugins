import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { WorkforestPage } from "./ui/page.js";
import {
  WorkforestProjectOverlay,
  openWorkforestProjectPicker,
} from "./ui/composer-project.js";
import { WORKFOREST_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
import { WorkforestInputs } from "./ui/environment-inputs.js";
import { ThreadPanel, ThreadHeader } from "./ui/thread-surfaces.js";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "workforest-project",
    scopes: ["new-thread"],
    plusMenu: [
      {
        id: "workforest-project",
        label: "Use Workforest source…",
        icon: "GitBranch",
        description:
          "Select a template or repository, then choose its environment.",
        disabled: (composer) => composer.isSubmitting,
        run: ({ composer }) => openWorkforestProjectPicker(composer),
      },
    ],
  });
  app.slots.experimental_appOverlay({
    id: "workforest-project-picker",
    component: WorkforestProjectOverlay,
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
});
