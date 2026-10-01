// src/lib/cancelBackend.ts
import net from 'net';

/** How long the cancel request's own socket may live before it is torn down. */
const CANCEL_SOCKET_MS = 2000;
/** The protocol's CancelRequest code: 1234 in the high 16 bits, 5678 in the low. */
const CANCEL_REQUEST_CODE = 80877102;

/** The parts of a connected node-postgres client a cancel request needs. */
interface CancellableClient {
  processID: number;
  /** 4 bytes, read as a signed int; protocol 3.2 allows a longer key, which pg would hold as bytes. */
  secretKey: number | Buffer;
  host: string;
  port: number;
}

/** An integer that fits 32 bits, signed or unsigned: pg reads the pid and key with readInt32BE. */
const fits32 = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= -0x80000000 && n <= 0xffffffff;
/** Protocol 3.2 allows a key of up to 256 bytes; the 3.0 key is 4. */
const keyBytes = (b: Buffer) => b.length >= 4 && b.length <= 256;

/**
 * A malformed pid or key is refused, not coerced: a coerced one makes a cancel that silently
 * does nothing, and a `false` here is what lets rollbackError warn that nothing was cancelled.
 */
const cancellable = (c: unknown): c is CancellableClient => {
  const x = c as Partial<CancellableClient> | null;
  return fits32(x?.processID) && (fits32(x.secretKey) || (Buffer.isBuffer(x.secretKey) && keyBytes(x.secretKey)))
    && typeof x.host === 'string' && typeof x.port === 'number';
};

/** CancelRequest: length, code, backend pid, then the key as sent at connect. */
function cancelRequest(processID: number, secretKey: number | Buffer): Buffer {
  const key = Buffer.isBuffer(secretKey) ? secretKey : Buffer.alloc(4);
  if (!Buffer.isBuffer(secretKey)) key.writeUInt32BE(secretKey >>> 0); // pg reads it signed
  const head = Buffer.alloc(12);
  head.writeInt32BE(12 + key.length, 0);
  head.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  head.writeUInt32BE(processID >>> 0, 8);
  return Buffer.concat([head, key]);
}

/**
 * Asks Postgres to cancel whatever this client's backend is running (R-176).
 *
 * Destroying a client's socket does not stop its statement: measured on PostgreSQL 16.15 with
 * client_connection_check_interval = 0, a `pg_sleep(12)` ran its full 12 s and a CPU-bound count
 * its full 3 s after the socket was destroyed, against about 100 ms with a cancel request first.
 * Without the cancel, a pool that frees a slot for a connection it gave up on can put more
 * backends on the server than its `max`.
 *
 * A cancel request travels on its own short-lived socket (the protocol's CancelRequest), so it
 * needs no pooled connection and works while the client's own socket is stuck. Best-effort and
 * fire-and-forget: nothing is awaited, the socket is destroyed after CANCEL_SOCKET_MS at the
 * latest, and its errors go nowhere.
 *
 * The request is written here, not through node-postgres's Client#cancel, so it depends only on
 * the four fields above, and a longer (Buffer) key goes out byte for byte. It is sent in
 * plaintext, before any TLS negotiation, as Client#cancel sends it. Postgres accepts that on a server its clients reach over TLS: measured
 * on PostgreSQL 16.15 with ssl = on, a plaintext CancelRequest cancelled a TLSv1.3 session's
 * pg_sleep at once (57014).
 *
 * Returns whether a request was attempted: false for anything that is not a connected pg client,
 * including one whose key fields have changed type. tests/integration/r176-cancel-backend.int.test.ts
 * cancels a real connection's statement, so a pg release that changes them turns it red.
 */
export function cancelBackend(client: unknown): boolean {
  if (!cancellable(client)) return false;
  const { processID, secretKey, host, port } = client;
  const packet = cancelRequest(processID, secretKey); // built first: anything it throws reaches the caller
  const socket = host.startsWith('/') ? net.connect({ path: `${host}/.s.PGSQL.${port}` }) : net.connect({ port, host });
  const timer = setTimeout(() => socket.destroy(), CANCEL_SOCKET_MS);
  timer.unref(); // must not keep a script alive
  socket.on('error', () => socket.destroy()); // nothing to report: the connection is being destroyed either way
  socket.on('close', () => clearTimeout(timer));
  socket.on('connect', () => socket.end(packet));
  return true;
}
