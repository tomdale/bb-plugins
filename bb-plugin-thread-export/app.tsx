import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ExportPanel } from "./components/ExportPanel";
import "./app.css";

export default definePluginApp((app) => {
  // An action tab: it joins the thread panel's action list and opens a
  // closable instance per thread, so the preview stays beside the thread.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "export",
    title: "Share as page",
    tooltip: "Build a standalone HTML page of this thread",
    icon: "Download",
    layout: "flush",
    component: ExportPanel,
  });
});
