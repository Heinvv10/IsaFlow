/**
 * R-176 — cancelBackend sends Postgres a CancelRequest for a client's backend on a socket of its
 * own. Proved against a plain TCP listener, so no database is involved: what matters here is the
 * packet, that nothing is sent for a client that is not a connected pg client, and that the
 * socket never outlives its bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'net';
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

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((done) => setImmediate(done));
  return cond();
};

describe('cancelBackend', () => {
  it('sends the protocol CancelRequest with the backend pid and secret key', async () => {
    cancelBackend({ processID: 4242, secretKey: 987654321, host: '127.0.0.1', port });
    expect(await until(() => Buffer.concat(received).length >= 16)).toBe(true);
    const packet = Buffer.concat(received);
    expect(packet.length).toBe(16);
    expect([packet.readInt32BE(0), packet.readInt32BE(4), packet.readInt32BE(8), packet.readInt32BE(12)])
      .toEqual([16, 80877102, 4242, 987654321]);
  });

  it.each([
    ['a mock client', { query: async () => ({}) }],
    ['a client that never connected', { processID: null, secretKey: null, host: '127.0.0.1', port: 0 }],
    ['null', null],
  ])('opens no socket for %s', async (_what, client) => {
    cancelBackend(client);
    await new Promise((done) => setTimeout(done, 30));
    expect(sockets).toHaveLength(0);
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
