/**
 * R-176 — cancelBackend sends Postgres a CancelRequest for a client's backend on a socket of its
 * own. Proved against a plain TCP listener, so no database is involved: what matters here is the
 * packet, that nothing is sent for a client that is not a connected pg client, and that the
 * socket never outlives its bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'net';
import pg from 'pg';
import { cancelBackend } from '@/lib/cancelBackend';

let server: net.Server;
let port = 0;
let received: Buffer[] = [];
let sockets: net.Socket[] = [];
let closed = 0;

beforeEach(async () => {
  received = []; sockets = []; closed = 0;
  server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('data', (d) => received.push(d));
    socket.on('close', () => { closed += 1; });
    socket.on('error', () => { closed += 0; }); // a reset from the client's destroy is expected
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as net.AddressInfo).port;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const s of sockets) s.destroy();
  await new Promise((done) => server.close(done));
});

/** Waits on the event loop, not on a tick count: a loaded machine can take a while to connect. */
const until = async (cond: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!cond() && Date.now() < deadline) await new Promise((done) => setImmediate(done));
  return cond();
};

describe('cancelBackend', () => {
  it('sends the protocol CancelRequest with the backend pid and secret key', async () => {
    expect(cancelBackend({ processID: 4242, secretKey: 987654321, host: '127.0.0.1', port })).toBe(true);
    expect(await until(() => Buffer.concat(received).length >= 16)).toBe(true);
    const packet = Buffer.concat(received);
    expect(packet.length).toBe(16);
    expect([packet.readInt32BE(0), packet.readInt32BE(4), packet.readInt32BE(8), packet.readInt32BE(12)])
      .toEqual([16, 80877102, 4242, 987654321]);
  });

  it.each([
    ['a 32-byte key (protocol 3.2)', Buffer.alloc(32, 7)],
    ['a 4-byte key held as a Buffer', Buffer.from([0x3a, 0xde, 0x68, 0xb1])],
  ])('sends a CancelRequest whose key is %s, byte for byte', async (_what, key) => {
    expect(cancelBackend({ processID: 4242, secretKey: key, host: '127.0.0.1', port })).toBe(true);
    expect(await until(() => Buffer.concat(received).length >= 12 + key.length)).toBe(true);
    const packet = Buffer.concat(received);
    expect(packet.length).toBe(12 + key.length);
    expect([packet.readInt32BE(0), packet.readInt32BE(4), packet.readInt32BE(8)]).toEqual([12 + key.length, 80877102, 4242]);
    expect(packet.subarray(12).equals(key)).toBe(true);
  });

  it('a negative 32-bit key (pg reads it signed) goes out as the same four bytes', async () => {
    expect(cancelBackend({ processID: 7, secretKey: -1, host: '127.0.0.1', port })).toBe(true);
    expect(await until(() => Buffer.concat(received).length >= 16)).toBe(true);
    expect(Buffer.concat(received).subarray(12).toString('hex')).toBe('ffffffff');
  });

  it.each([
    ['a mock client', { query: async () => ({}) }],
    ['a client that never connected', { processID: null, secretKey: null, host: '127.0.0.1', port: 0 }],
    ['a key of another type', { processID: 1, secretKey: 'abc', host: '127.0.0.1', port: 1 }],
    ['null', null],
  ])('opens no socket for %s, and says so', async (_what, client) => {
    expect(cancelBackend(client)).toBe(false);
    await new Promise((done) => setTimeout(done, 30));
    expect(sockets).toHaveLength(0);
  });

  it('a real pg.Client on the installed version has the fields the cancel reads (the key types: the integration suite)', () => {
    const client = new pg.Client({ host: '127.0.0.1', port: 1 }) as unknown as Record<string, unknown>;
    // processID and secretKey are set once the backend sends BackendKeyData; present before then.
    expect('processID' in client && 'secretKey' in client).toBe(true);
    expect([typeof client.host, typeof client.port]).toEqual(['string', 'number']);
  });

  it('its socket is torn down at the bound when the server never closes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cancelBackend({ processID: 1, secretKey: 2, host: '127.0.0.1', port });
    expect(await until(() => sockets.length === 1)).toBe(true);
    expect(closed).toBe(0);
    vi.advanceTimersByTime(1999);
    await new Promise((done) => setImmediate(done));
    expect(closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(await until(() => closed === 1)).toBe(true);
  });

  it('a refused connection raises nothing', async () => {
    const unhandled = vi.fn();
    process.on('uncaughtException', unhandled);
    try {
      await new Promise((done) => server.close(done)); // nothing listens on the port now
      cancelBackend({ processID: 1, secretKey: 2, host: '127.0.0.1', port });
      await new Promise((done) => setTimeout(done, 50));
    } finally {
      process.off('uncaughtException', unhandled);
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); // afterEach closes it
    }
    expect(unhandled).not.toHaveBeenCalled();
  });
});
