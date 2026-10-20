// Tells when a written part no longer matches the code. The user's thread keeps
// working while a walkthrough is written, so a part can describe code that has
// since changed. Each part remembers a fingerprint of the workspace's diff from
// when it was written; the walkthrough keeps the latest one.
import type { Part, Walkthrough } from "./schemas.ts";

export function isOutdated(walkthrough: Pick<Walkthrough, "codeFingerprint" | "status">, part: Pick<Part, "status" | "writtenAgainst">): boolean {
  return (
    walkthrough.status !== "done" &&
    part.status === "ready" &&
    typeof part.writtenAgainst === "string" &&
    typeof walkthrough.codeFingerprint === "string" &&
    part.writtenAgainst !== walkthrough.codeFingerprint
  );
}
