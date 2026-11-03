import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { retryDropped } from '../../e2e/helpers/droppedConnection';

let server: Server | undefined;
afterEach(() => { server?.close(); server?.closeAllConnections(); server = undefined; });

/** A server that resets the first `drops` connections, as `next dev` does mid-compile, then answers 200. */
async function flakyServer(drops: number): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = createServer((req, res) => {
    hits += 1;
    if (hits <= drops) { req.socket.destroy(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: 'ok' }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits };
}

describe('retryDropped', () => {
  it('a bare Playwright GET against a connection the server resets rejects (the #1110 failure)', async () => {
    const { url } = await flakyServer(1);
    const ctx = await request.newContext({ baseURL: url });
    await expect(ctx.get('/x')).rejects.toThrow(/ECONNRESET|socket hang up/);
    await ctx.dispose();
  });

  it('re-sends after a reset and returns the real response', async () => {
    const { url, hits } = await flakyServer(2);
    const ctx = await request.newContext({ baseURL: url });
    const res = await retryDropped(() => ctx.get('/x'));
    expect(res.status()).toBe(200);
    expect(hits()).toBe(3);
    await ctx.dispose();
  });

  it('gives up with the original error once the budget is spent', async () => {
    const { url } = await flakyServer(1000);
    const ctx = await request.newContext({ baseURL: url });
    await expect(retryDropped(() => ctx.get('/x'), 600)).rejects.toThrow(/ECONNRESET|socket hang up/);
    await ctx.dispose();
  });

  it('does not retry an error that is not a dropped connection', async () => {
    let calls = 0;
    await expect(retryDropped(async () => { calls += 1; throw new Error('expect(received).toBe(expected)'); })).rejects.toThrow(/expect/);
    expect(calls).toBe(1);
  });

  it('does not retry an HTTP error status: it is returned to the caller', async () => {
    server = createServer((_req, res) => { res.statusCode = 500; res.end('no'); });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const ctx = await request.newContext({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    expect((await retryDropped(() => ctx.get('/x'))).status()).toBe(500);
    await ctx.dispose();
  });
});
