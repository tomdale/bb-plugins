import { Socket } from "node:net";
import type { Duplex } from "node:stream";

export const CHANNEL_LIMIT = 16;
export const LOCAL_DIAL_TIMEOUT_MS = 5000;
export const CHANNEL_OPEN_TIMEOUT_MS = 10_000;

/** Reserves a slot before dialing the locally configured bridge, never peer metadata. */
export function forwardFixedBridge(options: {
  bridgePort: number; sockets: Set<Socket>; current: () => boolean;
  accept: () => Duplex; reject: () => void;
}) {
  let replied = false;
  const reject = () => { if (!replied) { replied = true; try { options.reject(); } catch {} } };
  if (!options.current() || options.sockets.size >= CHANNEL_LIMIT) { reject(); return; }
  const socket = new Socket();
  options.sockets.add(socket);
  let retired = false;
  let channel: Duplex | undefined;
  const retire = () => {
    if (retired) return;
    retired = true;
    clearTimeout(deadline);
    options.sockets.delete(socket);
    socket.destroy(); channel?.destroy(); reject();
  };
  const deadline = setTimeout(retire, LOCAL_DIAL_TIMEOUT_MS);
  socket.on("error", retire);
  socket.once("close", retire);
  socket.once("connect", () => {
    if (retired || socket.destroyed || !options.current()) { retire(); return; }
    clearTimeout(deadline);
    replied = true;
    try {
      channel = options.accept();
      channel.on("error", retire); channel.once("close", retire);
      socket.pipe(channel).pipe(socket);
    } catch { retire(); }
  });
  try { socket.connect({ host: "127.0.0.1", port: options.bridgePort }); } catch { retire(); }
}

/**
 * Bounds a relay's pending SSH open separately from the native operation.
 * SSH exposes no cancellable pending channel handle: timeout retires the SSH
 * session so an unresponsive peer cannot accumulate library-owned opens.
 */
export function forwardReverseSocket(options: {
  socket: Socket; sockets: Set<Socket>; current: () => boolean;
  request: (done: (error: Error | undefined, channel?: Duplex) => void) => void;
  stalled: () => void;
}) {
  const { socket, sockets } = options;
  if (socket.destroyed || !options.current() || sockets.size >= CHANNEL_LIMIT) { socket.destroy(); return; }
  sockets.add(socket);
  let retired = false;
  let replied = false;
  let requested = false;
  let channel: Duplex | undefined;
  const retire = () => {
    if (retired) return;
    retired = true;
    clearTimeout(deadline);
    sockets.delete(socket);
    socket.destroy(); channel?.destroy();
  };
  const timeout = () => {
    if (retired) return;
    const unresolved = requested && !replied && options.current();
    retire();
    if (unresolved) options.stalled();
  };
  const deadline = setTimeout(timeout, CHANNEL_OPEN_TIMEOUT_MS);
  const consumerClosed = () => {
    // An abandoned TCP consumer cannot cancel ssh2's library-owned open.
    // Keep its slot/deadline until the reply or session retirement, rather
    // than allowing repeated early closes to accumulate uncounted opens.
    if (replied || !requested || !options.current()) retire();
  };
  socket.on("error", consumerClosed); socket.once("close", consumerClosed);
  try {
    requested = true;
    options.request((error, opened) => {
      if (replied) { opened?.destroy(); return; }
      replied = true;
      clearTimeout(deadline);
      if (retired || error || !opened || socket.destroyed || !options.current()) { opened?.destroy(); retire(); return; }
      channel = opened;
      channel.on("error", retire); channel.once("close", retire);
      socket.pipe(channel).pipe(socket);
    });
  } catch { timeout(); }
}
