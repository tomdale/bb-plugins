// Sidebar Switcher has no backend behavior; BB requires a server entry for
// every plugin. All work happens in app.tsx against BB's public SDK.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(_bb: BbPluginApi) {}
