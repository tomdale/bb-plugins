import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireIntent, activate, beginRelease, finishRelease, isUsable } from "./grants.ts";

const intent = { key: "launch_test", hostId: "host_test", id: "grant_test", expiresAt: 1000 };

test("acquire retry and serialized recovery preserve the grant identity", () => {
  const pending = acquireIntent(undefined, intent);
  assert.equal(isUsable(pending, 10), false);
  const recovered = JSON.parse(JSON.stringify(pending));
  assert.deepEqual(acquireIntent(recovered, { ...intent, id: "must_not_replace" }), pending);
  const active = activate(recovered);
  assert.equal(isUsable(active, 999), true);
  assert.equal(isUsable(active, 1000), false);
  assert.deepEqual(activate(active), active);
  assert.throws(() => acquireIntent(active, { ...intent, hostId: "other" }));
});

test("interrupted acquisition release resolves by key/host without a returned grantId", () => {
  const pending = acquireIntent(undefined, intent);
  const revoking = beginRelease(pending, { ...intent, grantId: null });
  assert.equal(isUsable(revoking, 10), false);
  const revoked = finishRelease(JSON.parse(JSON.stringify(revoking)));
  assert.deepEqual(finishRelease(revoked), revoked);
  assert.deepEqual(beginRelease(revoked, { ...intent, grantId: null }), revoked);
  assert.throws(() => activate(revoked));
  assert.throws(() => acquireIntent(revoked, intent));
  assert.throws(() => finishRelease(pending));
});

test("release cannot target a different acquisition, machine, or grant", () => {
  const active = activate(acquireIntent(undefined, intent));
  for (const override of [{ key: "other" }, { hostId: "other" }, { grantId: "other" }]) {
    assert.throws(() => beginRelease(active, { ...intent, grantId: intent.id, ...override }));
  }
});
