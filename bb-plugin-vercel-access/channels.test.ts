import test from "node:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { CHANNEL_LIMIT, LOCAL_DIAL_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS, forwardFixedBridge, forwardReverseSocket } from "./channels.ts";

function localFixture(t: test.TestContext, mode: "pending" | "throw" | "accept-throw" = "pending") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = new Set<Socket>();
  let current = true;
  let accepted = 0;
  let rejected = 0;
  const channel = new PassThrough();
  const dial = t.mock.method(Socket.prototype, "connect", function(this: Socket, ...args: unknown[]) {
    assert.ok(sockets.has(this), "Accounting reserved before local dial");
    assert.deepEqual(args[0], { host: "127.0.0.1", port: 38991 });
    if (mode === "throw") throw new Error("Synthetic synchronous dial failure");
    return this;
  });
  const start = () => forwardFixedBridge({
    bridgePort: 38991, sockets, current: () => current,
    accept: () => { accepted++; if (mode === "accept-throw") throw new Error("Synthetic stale SSH accept"); return channel; },
    reject: () => { rejected++; },
  });
  t.after(() => { current = false; for (const socket of sockets) socket.destroy(); sockets.clear(); channel.destroy(); });
  return { sockets, start, dial, channel, counts: () => ({ accepted, rejected }), dispose: () => { current = false; for (const socket of sockets) socket.destroy(); sockets.clear(); } };
}

test("local dial reserves before connect, times out, and rejects late completion exactly once", t => {
  const fixture = localFixture(t);
  fixture.start();
  const socket = [...fixture.sockets][0];
  assert.ok(socket);
  t.mock.timers.tick(LOCAL_DIAL_TIMEOUT_MS - 1);
  assert.equal(fixture.sockets.size, 1);
  t.mock.timers.tick(1);
  assert.equal(fixture.sockets.size, 0);
  assert.equal(socket.destroyed, true);
  socket.emit("connect"); socket.emit("error", new Error("Synthetic late error"));
  assert.deepEqual(fixture.counts(), { accepted: 0, rejected: 1 });
});

for (const mode of ["throw", "error", "dispose", "accept-throw"] as const) test(`local dial failure/disposal releases accounting: ${mode}`, t => {
  const fixture = localFixture(t, mode === "throw" || mode === "accept-throw" ? mode : "pending");
  fixture.start();
  const socket = [...fixture.sockets][0];
  if (mode === "error") socket.emit("error", new Error("Synthetic connect error"));
  if (mode === "dispose") { fixture.dispose(); socket.emit("connect"); socket.emit("close"); }
  if (mode === "accept-throw") socket.emit("connect");
  t.mock.timers.tick(LOCAL_DIAL_TIMEOUT_MS + 1);
  assert.equal(fixture.sockets.size, 0);
  assert.deepEqual(fixture.counts(), mode === "accept-throw" ? { accepted: 1, rejected: 0 } : { accepted: 0, rejected: 1 });
});

test("local admission cap rejects before dialing and established channels have no dial-idle timer", t => {
  const fixture = localFixture(t);
  for (let i = 0; i < CHANNEL_LIMIT + 1; i++) fixture.start();
  assert.equal(fixture.dial.mock.callCount(), CHANNEL_LIMIT);
  assert.equal(fixture.sockets.size, CHANNEL_LIMIT);
  assert.equal(fixture.counts().rejected, 1);
  const socket = [...fixture.sockets][0];
  socket.emit("connect");
  t.mock.timers.tick(LOCAL_DIAL_TIMEOUT_MS + CHANNEL_OPEN_TIMEOUT_MS);
  assert.equal(socket.destroyed, false);
  assert.equal(fixture.sockets.size, 1, "Only pending dials expire, not native operation lifetime");
  fixture.channel.emit("error", new Error("Synthetic active channel failure"));
  assert.equal(fixture.sockets.size, 0);
});

function reverseFixture(t: test.TestContext, synchronousThrow = false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = new Set<Socket>();
  const socket = new Socket();
  let current = true;
  let stalled = 0;
  let done!: (error: Error | undefined, channel?: Duplex) => void;
  forwardReverseSocket({
    socket, sockets, current: () => current,
    request: callback => {
      assert.ok(sockets.has(socket), "Accounting reserved before SSH channel open");
      done = callback;
      if (synchronousThrow) throw new Error("Synthetic SSH open failure");
    },
    stalled: () => { stalled++; current = false; },
  });
  t.after(() => socket.destroy());
  return { socket, sockets, done, faults: () => stalled, dispose: () => { current = false; socket.destroy(); socket.emit("close"); sockets.clear(); } };
}

test("SSH open deadline releases its reservation, retires peer state and destroys a late channel", t => {
  const fixture = reverseFixture(t);
  t.mock.timers.tick(CHANNEL_OPEN_TIMEOUT_MS - 1);
  assert.equal(fixture.sockets.size, 1); assert.equal(fixture.faults(), 0);
  t.mock.timers.tick(1);
  assert.equal(fixture.sockets.size, 0); assert.equal(fixture.faults(), 1);
  assert.equal(fixture.socket.destroyed, true);
  const late = new PassThrough();
  fixture.done(undefined, late);
  assert.equal(late.destroyed, true);
  t.mock.timers.tick(CHANNEL_OPEN_TIMEOUT_MS);
  assert.equal(fixture.faults(), 1);
});

for (const failure of ["reply-error", "throw", "dispose"] as const) test(`SSH open failure/disposal releases accounting: ${failure}`, t => {
  const fixture = reverseFixture(t, failure === "throw");
  if (failure === "reply-error") fixture.done(new Error("Synthetic SSH rejection"));
  if (failure === "dispose") fixture.dispose();
  assert.equal(fixture.sockets.size, 0);
  const late = new PassThrough(); fixture.done(undefined, late);
  assert.equal(late.destroyed, true);
  t.mock.timers.tick(CHANNEL_OPEN_TIMEOUT_MS + 1);
  assert.equal(fixture.faults(), failure === "throw" ? 1 : 0);
});

test("consumer cancellation retains only the still-pending SSH reservation until reply", t => {
  const fixture = reverseFixture(t);
  fixture.socket.destroy(); fixture.socket.emit("close");
  assert.equal(fixture.sockets.size, 1, "A library-owned pending open is still accounted");
  assert.equal(fixture.faults(), 0, "Cancellation alone does not tear down a healthy shared SSH session");
  const late = new PassThrough(); fixture.done(undefined, late);
  assert.equal(late.destroyed, true);
  assert.equal(fixture.sockets.size, 0);
  t.mock.timers.tick(CHANNEL_OPEN_TIMEOUT_MS + 1);
  assert.equal(fixture.faults(), 0);
});

test("abandoned SSH opens remain capped and cannot accumulate after early consumer closes", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = new Set<Socket>();
  const consumers: Socket[] = [];
  let requested = 0;
  let current = true;
  for (let i = 0; i < CHANNEL_LIMIT + 1; i++) {
    const socket = new Socket(); consumers.push(socket);
    forwardReverseSocket({ socket, sockets, current: () => current, request: () => { requested++; }, stalled: () => { current = false; } });
    socket.destroy(); socket.emit("close");
  }
  assert.equal(requested, CHANNEL_LIMIT);
  assert.equal(sockets.size, CHANNEL_LIMIT);
  t.mock.timers.tick(CHANNEL_OPEN_TIMEOUT_MS);
  assert.equal(sockets.size, 0);
  for (const socket of consumers) assert.equal(socket.destroyed, true);
});
