import type { ComposerSelection } from "@get-bb/plugin-sdk/app";

export async function selectRegisteredProject(
  setSelection: (selection: ComposerSelection) => Promise<ComposerSelection>,
  requested: ComposerSelection,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  // Project registration reaches the sidebar catalog through asynchronous realtime updates.
  // The composer reconciles against that catalog and can temporarily return its previous project.
  for (let attempt = 0; attempt < 6; attempt++) {
    const settled = await setSelection(requested);
    if (settled.projectId === requested.projectId) return;
    if (attempt < 5) await pause(400);
  }
  throw new Error(
    "Project is registered, but the composer could not select it. Retry once the project appears in the project menu, or select it there.",
  );
}
