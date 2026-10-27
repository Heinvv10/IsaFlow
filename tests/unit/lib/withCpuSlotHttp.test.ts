/**
 * withCpuSlot against a REAL http.createServer (budgets P2 PR-B, after the final batch): on Node 20,
 * `req.destroyed` is true for every live request once its body has been read (Next reads it before
 * the route runs), so it cannot mean "the client has gone". A POST with a body, read first as Next
 * does, must reach the handler; a request whose client socket is closed while it waits for a slot
 * must be skipped when its turn comes, and the slot passed on.
 */
import { afterEach, describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CpuSlot, withCpuSlot } from '@/lib/withCpuSlot';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => { s.closeAllConnections(); return new Promise((r) => s.close(r)); }));
});

/** A server that reads the whole body (as Next's body parser does), then runs `route`. */
async function serve(route: ReturnType<typeof withCpuSlot>, seen: http.IncomingMessage[] = []): Promise<number> {
  const server = http.createServer((req, res) => {
    seen.push(req);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { void route(req as never, res as never); });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

function post(port: number, body: string): { done: Promise<{ status: number; text: string }>; destroy: () => void } {
  let destroy = () => {};
  const done = new Promise<{ status: number; text: string }>((resolve, reject) => {
    const q = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/x', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), cookie: 'sb-access-token=t' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    q.on('error', reject);
    destroy = () => q.destroy();
    q.end(body);
  });
  return { done, destroy };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; !ok(); i++) {
    if (i > 500) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const asUser = async () => ({ sub: 'u' });

describe('withCpuSlot over real sockets', () => {
  it('a POST whose body was read first reaches the handler (req.destroyed is true by then, and means nothing)', async () => {
    const slot = new CpuSlot('t', 1, 4, 60_000, 4);
    let calls = 0;
    const port = await serve(withCpuSlot(slot, async (_req, res) => { calls++; res.statusCode = 200; res.end('ok'); }, asUser));
    const r = post(port, JSON.stringify({ fileData: 'x'.repeat(100_000) }));
    const out = await Promise.race([r.done, sleep(3000).then(() => null)]);
    expect(out).toEqual({ status: 200, text: 'ok' });
    expect(calls).toBe(1);
  });

  it('a request whose client hangs up while it waits is skipped when its turn comes; the slot passes on', async () => {
    const slot = new CpuSlot('t', 1, 4, 60_000, 4);
    let release = () => {};
    const released = new Promise<void>((r) => { release = r; });
    const handled: string[] = [];
    const seen: http.IncomingMessage[] = [];
    const port = await serve(withCpuSlot(slot, async (req, res) => {
      handled.push(String(req.headers['content-length']));
      if (handled.length === 1) await released;
      res.statusCode = 200; res.end('ok');
    }, asUser), seen);
    const first = post(port, '{"n":1}');
    await until(() => slot.stats().running === 1, 'the first request to run');
    const gone = post(port, '{"n":22}');
    gone.done.catch(() => undefined); // its socket is destroyed below
    await until(() => slot.stats().waiting === 1, 'the second request to queue');
    gone.destroy();
    await until(() => seen[1]?.socket.destroyed === true, 'the server to see the socket close');
    const last = post(port, '{"n":333}');
    await until(() => slot.stats().waiting === 2, 'the third request to queue');
    release();
    expect(await first.done).toEqual({ status: 200, text: 'ok' });
    expect(await last.done).toEqual({ status: 200, text: 'ok' });
    expect(handled).toEqual(['7', '9']); // the 8-byte request (the gone one) never ran
    expect(slot.stats()).toEqual({ running: 0, waiting: 0 });
  });
});
