// Walkthrough plugin frontend. React and the SDK come from the BB host at
// runtime; components/ui/ is vendored source this plugin owns.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PAGE_PATH, PANEL_ACTION_ID } from "./src/schemas.ts";
import { WalkthroughPane } from "./src/ui/Pane.tsx";
import { WalkthroughAutoOpener } from "./src/ui/Starter.tsx";
import { WalkthroughWindow } from "./src/ui/Window.tsx";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Walkthrough",
    icon: "Explore",
    component: WalkthroughPane,
    layout: "flush",
  });
  // The page a pop-out window loads; BB also lists it in the sidebar navigation.
  app.slots.navPanel({ id: "walkthroughs", title: "Walkthroughs", icon: "Explore", path: PAGE_PATH, component: WalkthroughWindow });
  app.slots.experimental_threadHeaderAction({ id: "walkthrough", title: "Walkthrough", component: WalkthroughAutoOpener });
});
