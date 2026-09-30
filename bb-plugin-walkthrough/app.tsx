// Walkthrough plugin frontend. React and the SDK come from the BB host at
// runtime; components/ui/ is vendored source this plugin owns.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID, PAUSE_RENDERER_ID } from "./src/schemas.ts";
import { offerNoteDraft } from "./src/ui/hooks.ts";
import { WalkthroughPanel } from "./src/ui/Panel.tsx";
import { PauseForm } from "./src/ui/PauseForm.tsx";
import { DiffDirective, HeaderChip, OutlineDirective } from "./src/ui/surfaces.tsx";

const START_PROMPT = "Walk me through these changes.";

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: PAUSE_RENDERER_ID, component: PauseForm });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Walkthrough",
    icon: "Explore",
    component: WalkthroughPanel,
    layout: "flush",
  });

  app.slots.experimental_threadHeaderAction({ id: "progress", title: "Walkthrough progress", component: HeaderChip });

  app.slots.messageDirective({ id: "walkthrough-outline", component: OutlineDirective });
  app.slots.messageDirective({ id: "walkthrough-diff", component: DiffDirective });

  app.slots.messageAction({
    id: "add-note",
    title: "Add to walkthrough notes",
    icon: "ListTodo",
    run: ({ threadId, message, selectedText, openPanel }) => {
      offerNoteDraft(threadId, (selectedText ?? message.text).trim().slice(0, 2000));
      openPanel({ actionId: PANEL_ACTION_ID, title: "Walkthrough" });
    },
  });

  app.commands.register({
    id: "open-panel",
    title: "Walkthrough: open panel for this thread",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel({ actionId: PANEL_ACTION_ID, title: "Walkthrough" });
    },
  });

  app.composer.customize({
    id: "start",
    scopes: ["thread", "new-thread"],
    plusMenu: [
      {
        id: "start-walkthrough",
        label: "Start a walkthrough",
        description: "Ask the agent to walk you through the changes group by group",
        icon: "Explore",
        run: ({ composer }) => {
          composer.updateText((current) => (current.trim() === "" ? START_PROMPT : `${current.trimEnd()}\n\n${START_PROMPT}`));
          composer.focus();
        },
      },
    ],
  });
});
