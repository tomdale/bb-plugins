import { describe, expect, it, vi } from "vitest";
import { selectRegisteredProject } from "../ui/select-project.js";
const requested = {
  projectId: "registered-project",
  environment: {
    type: "provider" as const,
    environmentProviderId: "workforest-workspace",
    machine: { type: "existing" as const, hostId: "machine" },
    inputs: null,
  },
};
describe("registered project selection", () => {
  it("retries catalog reconciliation without dropping the requested environment", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce({ projectId: "old" })
      .mockResolvedValueOnce({ projectId: "proj_personal" })
      .mockResolvedValue(requested);
    const pause = vi.fn().mockResolvedValue(undefined);
    await selectRegisteredProject(select, requested, pause);
    expect(select).toHaveBeenCalledTimes(3);
    for (const call of select.mock.calls) expect(call).toEqual([requested]);
    expect(pause).toHaveBeenCalledTimes(2);
  });
  it("does not delay when the project is already in the catalog", async () => {
    const pause = vi.fn();
    await selectRegisteredProject(
      vi.fn().mockResolvedValue(requested),
      requested,
      pause,
    );
    expect(pause).not.toHaveBeenCalled();
  });
  it("bounds retries when the selection is refused", async () => {
    const select = vi.fn().mockResolvedValue({ projectId: "old" });
    const pause = vi.fn().mockResolvedValue(undefined);
    await expect(
      selectRegisteredProject(select, requested, pause),
    ).rejects.toThrow("Retry once the project appears");
    expect(select).toHaveBeenCalledTimes(6);
  });
  it("preserves actionable host errors without retrying", async () => {
    const select = vi
      .fn()
      .mockRejectedValue(new Error("Attachments could not be copied"));
    await expect(
      selectRegisteredProject(select, requested, vi.fn()),
    ).rejects.toThrow("Attachments could not be copied");
    expect(select).toHaveBeenCalledTimes(1);
  });
});
