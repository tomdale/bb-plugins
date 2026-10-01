import { describe, expect, it } from "vitest";
import { groupInventory, relativeUpdated } from "../ui/inventory-model.js";
import { entry } from "./fixtures.js";
import type { Entry } from "../contracts.js";
const entries: Entry[] = [
  entry,
  {
    ...entry,
    selector: "app/older",
    changeName: "older",
    modifiedAtMs: 0,
    state: "stale",
  },
  {
    ...entry,
    selector: "services/new",
    changeName: "new",
    groupName: "services",
    type: "template-workspace",
    repos: ["api", "web"],
    modifiedAtMs: 2000,
  },
];
describe("inventory organization", () => {
  it("groups checkouts and sorts both groups and changes by recency", () => {
    const groups = groupInventory(entries, "", "all", "recent");
    expect(groups.map((group) => group.name)).toEqual(["services", "app"]);
    expect(groups[1]!.entries.map((entry) => entry.changeName)).toEqual([
      "fix-auth",
      "older",
    ]);
    expect(entries[0]).toBe(entry);
  });
  it("filters types, exceptions, and multiple search terms including member repositories", () => {
    expect(
      groupInventory(entries, "", "attention", "recent")[0]!.entries.map(
        (entry) => entry.state,
      ),
    ).toEqual(["stale"]);
    expect(
      groupInventory(entries, "api new", "workspaces", "recent")[0]!.name,
    ).toBe("services");
    expect(groupInventory(entries, "", "worktrees", "name")).toHaveLength(1);
    expect(groupInventory(entries, "missing", "all", "recent")).toEqual([]);
  });
  it("keeps workspace and repository groups distinct when names collide", () => {
    expect(
      groupInventory(
        [entry, { ...entry, type: "adhoc-workspace" }],
        "",
        "all",
        "name",
      ),
    ).toHaveLength(2);
  });
  it("sorts alphabetically when requested", () => {
    expect(
      groupInventory(entries, "", "all", "name").map((group) => group.name),
    ).toEqual(["app", "services"]);
  });
  it("formats recency and tolerates clock skew", () => {
    expect(relativeUpdated(2000, 1000)).toBe("Today");
    expect(relativeUpdated(0, 86400000)).toBe("Yesterday");
    expect(relativeUpdated(0, 86400000 * 10)).toBe("10d ago");
  });
});
