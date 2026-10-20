// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fileTarget, workspaceRelativePath } from "../src/files.ts";
import { LocationLink } from "../src/ui/parts.tsx";
import { Prose } from "../src/ui/prose.tsx";

const files = { environmentId: "env_notes", hostId: "host_1", workspacePath: "/work/notes" };
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => { mounted.splice(0).forEach((slot) => slot.unmount()); });

function mountLinks() {
  const slot = renderSlot({ component: () => <>
    <Prose text="The [objective](line:4-7) links to [analysis](/work/toolbelt/src/analysis.ts#L57-77)." context={{ files, codePath: "/work/toolbelt/src/identity.ts" }} />
    <LocationLink files={files} location={{ path: "/work/toolbelt/src/identity.ts", startLine: 3, endLine: 14 }} />
    <LocationLink files={files} location={{ path: "/work/notes/local.ts", startLine: 2 }} />
  </> }, {});
  mounted.push(slot);
  return slot;
}

describe("walkthrough file navigation", () => {
  it("opens line references and absolute file links on their explicit host", () => {
    const slot = mountLinks();
    fireEvent.click(slot.getByRole("link", { name: "objective" }));
    fireEvent.click(slot.getByRole("link", { name: "analysis" }));
    fireEvent.click(slot.getByRole("link", { name: "/work/toolbelt/src/identity.ts:3-14" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host_1", path: "/work/toolbelt/src/identity.ts" }, location: { kind: "range", startLine: 4, endLine: 7 } } },
      { method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host_1", path: "/work/toolbelt/src/analysis.ts" }, location: { kind: "range", startLine: 57, endLine: 77 } } },
      { method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host_1", path: "/work/toolbelt/src/identity.ts" }, location: { kind: "range", startLine: 3, endLine: 14 } } },
    ]);
  });

  it("normalizes absolute paths inside the workspace before opening them", () => {
    const slot = mountLinks();
    fireEvent.click(slot.getByRole("link", { name: "/work/notes/local.ts:2" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_notes", path: "local.ts" }, location: { kind: "line", line: 2, column: null } } },
    ]);
  });

  it("does not mistake sibling roots or traversal paths for workspace files", () => {
    expect(workspaceRelativePath("/work/notes-other/a.ts", "/work/notes")).toBeNull();
    expect(workspaceRelativePath("./src/a.ts", "/work/notes")).toBe("src/a.ts");
    expect(workspaceRelativePath("../a.ts", "/work/notes")).toBeNull();
    expect(fileTarget({ ...files, hostId: null }, "/elsewhere/a.ts")).toBeNull();
  });
});
