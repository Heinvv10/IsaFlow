/**
 * readJsonBody on a REAL HTTP socket (round-3 verifier L3): an over-cap chunked upload is refused
 * 413 at once, AND the rest of the upload is drained (or the connection closed) promptly, so the
 * socket does not stall until the server's request timeout. A mock Readable cannot show this:
 * the stall comes from the HTTP parser's backpressure on a real connection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { JsonBodyError, readJsonBody } from '@/lib/readJsonBody';

const MB = 1048576;
let server: http.Server;
let port = 0;
const events: Array<{ at: number; what: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('end', () => events.push({ at: Date.now(), what: 'request drained' }));
    req.socket.on('close', () => events.push({ at: Date.now(), what: 'socket closed' }));
    readJsonBody(req, { maxBytes: MB, totalMs: 20_000, idleMs: 10_000 }).then(
      () => res.writeHead(200).end('ok'),
      (err: unknown) => res.writeHead(err instanceof JsonBodyError ? err.status : 500).end('refused'),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('readJsonBody on a real socket', () => {
  it('an over-cap chunked upload gets 413 at once, and the upload drains or the connection closes promptly', async () => {
    events.length = 0;
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    let respondedAt = 0;
    socket.on('data', (d) => { response += d.toString(); if (!respondedAt && response.includes('\r\n\r\n')) respondedAt = Date.now(); });
    socket.on('error', () => events.push({ at: Date.now(), what: 'client socket error' }));
    const t0 = Date.now();
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    let sent = 0;
    // 16 MB (16 times the cap), honouring backpressure: a stalled server stops this loop.
    const upload = (async () => {
      for (let i = 0; i < 64 && !socket.destroyed; i++) {
        // One write per chunk: a short-circuit would leave a chunk half-framed.
        const ok = socket.write(Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from('\r\n')]));
        sent += chunk.length;
        if (!ok) await new Promise<void>((resolve) => { socket.once('drain', resolve); socket.once('close', resolve); });
      }
      if (!socket.destroyed) socket.write('0\r\n\r\n');
    })();
    const deadline = t0 + 5000;
    while (Date.now() < deadline && !(respondedAt && events.some((e) => e.what !== 'client socket error'))) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const settledAt = events.find((e) => e.what === 'request drained' || e.what === 'socket closed');
    socket.destroy();
    await upload;
    expect(response.split('\r\n')[0], response.slice(0, 120)).toBe('HTTP/1.1 413 Payload Too Large');
    expect(respondedAt - t0, 'the 413 arrives at once').toBeLessThan(2000);
    expect(settledAt, `upload ${(sent / MB).toFixed(1)} MB sent; events ${JSON.stringify(events.map((e) => `${e.what} +${e.at - t0}ms`))}`).toBeDefined();
    expect(settledAt!.at - t0).toBeLessThan(5000);
  }, 15000);
});
