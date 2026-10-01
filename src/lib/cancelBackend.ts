// src/lib/cancelBackend.ts
import pg from 'pg';

/** How long the cancel request's own socket may live before it is torn down. */
const CANCEL_SOCKET_MS = 2000;

/** The parts of a connected node-postgres client a cancel request needs. */
interface CancellableClient {
  processID: number;
  secretKey: number;
  host: string;
  port: number;
}
interface CancelConnection {
  connect(port: number | string, host?: string): void;
  cancel(processID: number, secretKey: number): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  stream: { destroy(): void };
}

const cancellable = (c: unknown): c is CancellableClient => {
  const x = c as Partial<CancellableClient> | null;
  return typeof x?.processID === 'number' && typeof x.secretKey === 'number'
    && typeof x.host === 'string' && typeof x.port === 'number';
};

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
 * latest, and its errors go nowhere. A client that is not a connected pg client is ignored.
 */
export function cancelBackend(client: unknown): void {
  if (!cancellable(client)) return;
  const { processID, secretKey, host, port } = client;
  // An unconnected Client is only the carrier of a Connection, as pg's own Client#cancel uses it.
  const con = (new pg.Client({ host, port }) as unknown as { connection: CancelConnection }).connection;
  const timer = setTimeout(() => con.stream.destroy(), CANCEL_SOCKET_MS);
  const done = () => clearTimeout(timer);
  con.on('error', done); // nothing to report: the connection is being destroyed either way
  con.on('end', done);
  con.on('connect', () => con.cancel(processID, secretKey));
  if (host.startsWith('/')) con.connect(`${host}/.s.PGSQL.${port}`);
  else con.connect(port, host);
}
