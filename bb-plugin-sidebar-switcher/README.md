# Sidebar Switcher for BB

Switch which plugin renders BB's sidebar thread list, navigation, and header
from the main window instead of Settings → Appearance.

## Using it

- **Sidebar footer → Sidebar plugins** (panel icon) opens a menu with one
  group per sidebar slot: **Thread list**, **Navigation**, and **Header**.
  Pick a row to switch; the menu stays open so you can compare providers.
  A group appears only when it has a real alternative.
- **Command palette** (Mod+Shift+P):
  - *Switch to next sidebar thread list* cycles through enabled thread list
    providers in title order. Default shortcut: **Mod+Alt+L** (rebindable in
    Settings → Keyboard; BB leaves it unbound if another default claims it).
  - *Choose sidebar plugins…* opens the footer menu.

Each choice writes the same server-synced UI preference that Settings →
Appearance writes (`sidebar.threadListProvider`, `sidebar.navigationProvider`,
`sidebar.headerProvider`), so it applies to every window and survives
restarts. **Automatic** and **None** are BB's own sentinel choices.

## How providers are discovered

BB's plugin SDK does not expose other plugins' slot registrations, so the
switcher finds them itself, once per bundle hash per window:

1. List installed plugins and keep the enabled ones with a compatible
   frontend bundle.
2. Fetch each bundle's text and skip any that never mention
   `experimental_threadList(`, `experimental_sidebarNavigation(`, or
   `experimental_sidebarHeader(`.
3. Import the remaining bundles by the URL BB already imported them from,
   which returns BB's existing module instance, and run the app definition's
   `setup` against a recording builder. Only the three sidebar slot calls are
   recorded; every other builder surface is a no-op.

BB re-runs `setup` on every reinterpretation, so running it again is within
its contract. One consequence: a plugin that keeps an
`experimental_sidebarFooter` controller in module state *and* registers a
sidebar slot would have that controller replaced by a no-op once the switcher
inspects it.

The *Automatic* row's hint approximates BB's choice with plugin-id order;
BB's actual order is internal.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
../scripts/bb-plugin-smoke "$PWD"
```

`providers.ts` holds the pure model (discovery recorder, choices, cycling);
`store.ts` holds the window-wide state and preference writes with revision
retry; `app.tsx` wires them to the footer, palette, and an app overlay that
hands the SDK to commands. The server entry is empty because BB requires one.
