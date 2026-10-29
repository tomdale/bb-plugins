import { createHash } from "node:crypto";
import type { RelayIdentity } from "./relay-contract.js";

export const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const relayName = (identity: RelayIdentity) => `bb-relay-${hash(JSON.stringify([identity.owner, identity.key, identity.generation])).slice(0, 48)}`;
export const relayTags = (identity: RelayIdentity) => ({ bbProvider: "vercel-access-relay", bbOwner: identity.owner, bbKey: hash(identity.key), bbGeneration: identity.generation });
