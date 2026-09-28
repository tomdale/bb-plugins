// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { contract } from "./src/contract.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});
async function mount(
  mode: "dynamic" | "static",
  rpc: Record<string, (input: unknown) => unknown>,
) {
  const app = await loadPluginApp(() => import("./app.js"));
  const registration = app.settingsSections.find(
    (section) => section.id === mode,
  )!;
  const slot = renderSlot(registration, {}, { rpc });
  cleanups.push(() => slot.lifecycle.unmount());
  return slot;
}

describe("environment settings forms", () => {
  it("adds a dynamic command without JSON editing", async () => {
    let saved: unknown;
    const slot = await mount("dynamic", {
      dynamicList: () => ({ entries: [], revision: "r1" }),
      dynamicSave: (input) => {
        const parsed = contract.dynamicSave.input.parse(input);
        saved = parsed;
        return { entries: [parsed.entry], revision: "r2" };
      },
    });
    await slot.findByText("No dynamic variables configured.");
    fireEvent.click(slot.getByRole("button", { name: "Add dynamic variable" }));
    fireEvent.change(slot.getByLabelText("Variable name"), {
      target: { value: "TOKEN" },
    });
    fireEvent.change(slot.getByLabelText("Command"), {
      target: { value: "printf secret" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save variable" }));
    await slot.findByText("TOKEN");
    expect(saved).toEqual({
      originalName: null,
      entry: { name: "TOKEN", command: "printf secret" },
      revision: "r1",
    });
  });
  it("renames a static variable preserving its hidden value", async () => {
    let saved: unknown;
    const slot = await mount("static", {
      staticList: () => ({
        names: ["TOKEN"],
        revision: "r1",
        path: "/test/env.json",
      }),
      staticSave: (input) => {
        const parsed = contract.staticSave.input.parse(input);
        saved = parsed;
        return { names: [parsed.name], revision: "r2", path: "/test/env.json" };
      },
    });
    await slot.findByText("TOKEN");
    fireEvent.click(slot.getByRole("button", { name: "Edit TOKEN" }));
    expect(slot.queryByLabelText("Value")).toBeNull();
    fireEvent.change(slot.getByLabelText("Variable name"), {
      target: { value: "RENAMED" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save variable" }));
    await slot.findByText("RENAMED");
    expect(saved).toEqual({
      originalName: "TOKEN",
      name: "RENAMED",
      value: null,
      revision: "r1",
    });
  });
  it("replaces a value with an empty string only when explicitly requested", async () => {
    let saved: unknown;
    const slot = await mount("static", {
      staticList: () => ({
        names: ["TOKEN"],
        revision: "r1",
        path: "/test/env.json",
      }),
      staticSave: (input) => {
        const parsed = contract.staticSave.input.parse(input);
        saved = parsed;
        return { names: [parsed.name], revision: "r2", path: "/test/env.json" };
      },
    });
    await slot.findByText("TOKEN");
    fireEvent.click(slot.getByRole("button", { name: "Edit TOKEN" }));
    fireEvent.click(slot.getByLabelText("Replace saved value"));
    expect(slot.getByLabelText("Value").getAttribute("type")).toBe("password");
    fireEvent.click(slot.getByRole("button", { name: "Save variable" }));
    await waitFor(() =>
      expect(saved).toEqual({
        originalName: "TOKEN",
        name: "TOKEN",
        value: "",
        revision: "r1",
      }),
    );
  });
  it("requires confirmation before removing and allows cancellation", async () => {
    let removed = false;
    const slot = await mount("dynamic", {
      dynamicList: () => ({
        entries: [{ name: "TOKEN", command: "printf x" }],
        revision: "r1",
      }),
      dynamicRemove: () => {
        removed = true;
        return { entries: [], revision: "r2" };
      },
    });
    await slot.findByText("TOKEN");
    fireEvent.click(slot.getByRole("button", { name: "Remove TOKEN" }));
    expect(removed).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(removed).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Remove TOKEN" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm removal" }));
    await slot.findByText("No dynamic variables configured.");
    expect(removed).toBe(true);
  });
  it("keeps edits when saving fails and lets users cancel then reload", async () => {
    const slot = await mount("dynamic", {
      dynamicList: () => ({ entries: [], revision: "r1" }),
      dynamicSave: () => {
        throw new Error(
          "Dynamic variables changed. Reload the list before saving.",
        );
      },
    });
    await slot.findByText("No dynamic variables configured.");
    fireEvent.click(slot.getByRole("button", { name: "Add dynamic variable" }));
    fireEvent.change(slot.getByLabelText("Variable name"), {
      target: { value: "TOKEN" },
    });
    fireEvent.change(slot.getByLabelText("Command"), {
      target: { value: "printf secret" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save variable" }));
    await slot.findByRole("alert");
    expect((slot.getByLabelText("Command") as HTMLTextAreaElement).value).toBe(
      "printf secret",
    );
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByLabelText("Command")).toBeNull();
  });
});
