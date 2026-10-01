import type { Detail, Entry } from "../contracts.js";
export const entry: Entry = {
  selector: "app/fix-auth",
  type: "worktree",
  groupName: "app",
  changeName: "fix-auth",
  path: "/work/app/fix-auth",
  state: "ready",
  repository: "app",
  modifiedAtMs: 1000,
};
export const detail: Detail = {
  selector: entry.selector,
  path: entry.path,
  repositories: [
    {
      name: "app",
      path: entry.path,
      branch: "feature/fix-auth",
      defaultBranch: "main",
      state: "clean",
      dirty: { total: 0 },
      ahead: 1,
      behind: 0,
      integrated: false,
      setup: { status: "ready" },
    },
  ],
  tasks: [
    {
      selector: "app/tests",
      parentRepo: "app",
      slug: "tests",
      path: "/work/app/_tasks/fix-auth/tests",
      branch: "feature/tests",
      state: "ready",
      merged: false,
    },
  ],
};
export const bootstrap = {
  hosts: [{ id: "h1", name: "Dev machine", status: "connected" }],
  projects: [
    { id: "p1", name: "App", sources: [{ hostId: "h1", path: entry.path }] },
  ],
};
