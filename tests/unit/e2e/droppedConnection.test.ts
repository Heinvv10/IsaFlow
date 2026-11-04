import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryDropped, type Running } from '../../e2e/helpers/droppedConnection';

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

  describe('inside a test run', () => {
    const dropOnce = () => {
      let calls = 0;
      return { calls: () => calls, call: async () => { calls += 1; if (calls === 1) throw new Error('apiRequestContext.get: read ECONNRESET'); return 'ok'; } };
    };
    const ctxAt = (baseURL: string | undefined, notes: string[]): Running => ({ title: 'z4 keyboard', baseURL, note: (t) => notes.push(t) });

    it('logs each re-send with test name, error code and attempt, on stderr and as an annotation', async () => {
      const notes: string[] = [];
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const d = dropOnce();
      await expect(retryDropped(d.call, 5000, ctxAt('http://localhost:3447', notes))).resolves.toBe('ok');
      expect(notes).toEqual(['test="z4 keyboard" code=ECONNRESET attempt=1']);
      expect(write).toHaveBeenCalledWith('[dropped-connection] test="z4 keyboard" code=ECONNRESET attempt=1\n');
      write.mockRestore();
    });

    it.each(['https://app.isaflow.co.za', 'http://10.0.0.5:3101', undefined])('does not re-send against %s (a reset there is an outage signal)', async (baseURL) => {
      const notes: string[] = [];
      const d = dropOnce();
      await expect(retryDropped(d.call, 5000, ctxAt(baseURL, notes))).rejects.toThrow(/ECONNRESET/);
      expect(d.calls()).toBe(1);
      expect(notes).toEqual([]);
    });
  });
});
