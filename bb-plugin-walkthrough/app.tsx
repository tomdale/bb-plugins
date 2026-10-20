// Walkthrough plugin frontend. React and the SDK come from the BB host at
// runtime; components/ui/ is vendored source this plugin owns.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PAGE_PATH, PANEL_ACTION_ID } from "./src/schemas.ts";
import { WalkthroughPane } from "./src/ui/Pane.tsx";
import { WalkthroughAutoOpener } from "./src/ui/Starter.tsx";
import { WalkthroughFullPage } from "./src/ui/FullPage.tsx";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Walkthrough",
    icon: "Explore",
    component: WalkthroughPane,
    layout: "flush",
  });
  // A walkthrough as a full page; BB also lists every nav panel in the sidebar navigation.
  app.slots.navPanel({ id: "walkthroughs", title: "Walkthroughs", icon: "Explore", path: PAGE_PATH, component: WalkthroughFullPage });
  app.slots.experimental_threadHeaderAction({ id: "walkthrough", title: "Walkthrough", component: WalkthroughAutoOpener });
});
