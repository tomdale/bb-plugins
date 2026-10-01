# Sidebar Switcher for BB

Switch which plugin renders BB's sidebar from the main window instead of
Settings → Appearance.

> **Warning:** BB has no API for listing other plugins' sidebars, so this
> plugin finds them by re-running each candidate plugin's frontend `setup`
> against a recording stub. That works for well-behaved plugins, but a plugin
> whose `setup` has side effects could misbehave, and a BB change to plugin
> loading could break discovery.

## Using it

- **Sidebar footer → Sidebar plugins** (panel icon) opens a menu of enabled
  sidebars. Pick one to switch; the menu closes as the change applies.
  *Automatic* appears only while it is the current setting.
  If a plugin also replaces BB's sidebar navigation or the controls beside
  the sidebar toggle (Settings → Appearance → Navigation / Header), a group
  for that appears too.
- **Command palette** (Mod+Shift+P):
  - *Switch to next sidebar* — default shortcut **Mod+Alt+L**.
  - *Switch to previous sidebar* — unbound by default.
  - *Choose sidebar plugins…* opens the footer menu.

  Bind or rebind shortcuts in Settings → Keyboard. Next and previous step
  through sidebars in title order.

Choices write the same synced UI preferences as Settings → Appearance
(`sidebar.threadListProvider`, `sidebar.navigationProvider`,
`sidebar.headerProvider`), so they apply to every window.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
../scripts/bb-plugin-smoke "$PWD"
```

`providers.ts` holds the pure model (discovery recorder, choices, stepping);
`store.ts` holds the window-wide state and preference writes with revision
retry; `app.tsx` wires them to the footer, palette, and an app overlay that
hands the SDK to commands. The server entry is empty because BB requires one.
