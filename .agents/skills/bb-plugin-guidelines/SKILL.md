---
name: bb-plugin-guidelines
description: Tom's standing rules for building and changing BB plugins (UI that matches BB, SDK integration, agent tool contracts and instructions, verification). Use for any change to a BB plugin's app UI, settings, agent tools or instructions, or SDK dependency, alongside BB's own bb-plugin-authoring skill for the SDK API itself.
---

# BB plugin guidelines

BB's `bb-plugin-authoring` skill documents the SDK; this one covers how Tom wants plugins built on it.

## Look and behave like BB

A plugin's UI should be indistinguishable from BB's own. Build it from BB's registry components, vendored with `npx shadcn add @bb/<name>` at the registry tag pinned in the package's `components.json` (`select`, `radio-group`, `dropdown-menu`, `context-menu`, `popover`, `dialog`, `tooltip`, and so on). A native `<select>`, visible native radio or checkbox, or hand-rolled menu looks broken next to BB's controls. Registry components that draw in `primary` (BB's blue accent) need neutral classes at the call site when BB itself would not use the accent for that control. The one exception is a reading surface: a document-like view the plugin owns may have its own typography, colors, and layout. The controls on and around it stay BB's.

BB does not show `title` attributes, so every tooltip goes through the vendored `@bb/tooltip`, wrapped once in a small hint component the plugin reuses. Icons come from BB's icon set through the SDK's icon component; an unknown icon name renders as a lightning bolt, so check that a name exists, or declare an asset icon in `package.json` under `bb.branding.experimental_icons`. Inherit BB's fonts and theme colors and extract icons or tokens from the running app instead of drawing, bundling, or inventing them.

Copy is short and plain: sentence-case labels, everyday words, no counters or help text under every field, and an ellipsis only on an item that opens a dialog.

Hover-revealed buttons take no space until shown (collapse to zero width rather than hide with opacity alone), reveal together on row hover, `focus-visible`, or while one of their menus is open, and stop `pointerdown` so they never start a row drag. Overlays use `pointer-events: none` where they must not block BB's controls and animate only transform and opacity.

A button that runs an action on click must not be a `PopoverTrigger`; anchor its popover with `PopoverAnchor` and open it from hover or keyboard handlers. Keep a dialog's contents stable while it animates closed (keep the open flag separate from the edited entity), and move focus somewhere sensible when the focused row is deleted.

A settings view must not write until its stored state has loaded, and must sanitize a bad stored field instead of discarding the whole record; a whole-array write from an unloaded view replaces everything stored.

File links follow BB's target rules: workspace-relative paths for workspace targets, host targets for paths outside the workspace, and percent-encoded or angle-bracketed paths with spaces. Test a link with the real Markdown renderer and a simulated click, and assert its `href`.

## SDK and contracts

Build against the released SDK the package declares. Feature-detect optional or experimental slots at runtime instead of raising `engines.bb` or `engines.bbPluginSdk`, since BB refuses to load a plugin whose engines it does not satisfy. To try an unreleased local SDK, copy its built package into `node_modules/@get-bb/plugin-sdk` (and redo it after any `npm ci`); a symlink pulls in a second React and breaks hooks.

Agent tool schemas are a contract with every running agent session, and reloading a plugin does not update a session's tools. Keep existing field names, accept older shapes as aliases, and migrate stored data when a schema changes.

BB truncates plugin instructions at 4,096 characters per text, silently. Attach a tool's instructions to that tool rather than concatenating everything into one `configure` text, and keep a test that measures every delivered instruction string against the limit.

## Verify before reporting

Tests and typechecks do not show what a UI change looks like. After deploying from the canonical checkout, look at the change in the running app, or in a throwaway BB, with browser automation: hover, open its menus, measure alignment, and screenshot the result. Link every screenshot you mention. Do not exercise destructive actions on Tom's real threads while checking.
