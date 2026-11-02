// The cookie-carrying request context the seeder logs in with: it must return what the server set, send it back, and
// drop a cookie the server expires, or a login that worked would look anonymous to the next request.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FetchContext } from '../../../scripts/ci/golden/fetchContext';

let server: Server;
let base = '';
const seen: Array<{ url: string; cookie: string; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', cookie: String(req.headers.cookie ?? ''), body });
      if (req.url === '/login') res.setHeader('set-cookie', ['sb-access-token=abc; Path=/; HttpOnly', 'isaflow_csrf=tok; Path=/']);
      if (req.url === '/logout') res.setHeader('set-cookie', ['sb-access-token=; Path=/; Max-Age=0']);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { ok: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

describe('FetchContext', () => {
  it('keeps cookies the server sets, sends them back, posts json, and forgets an expired one', async () => {
    const ctx = new FetchContext(base);
    const login = await ctx.post('/login', { data: { email: 'a' } });
    expect(login.status()).toBe(200);
    expect(await login.json()).toEqual({ success: true, data: { ok: 1 } });
    expect(seen[0]!.body).toBe('{"email":"a"}');
    expect((await ctx.storageState()).cookies).toEqual([{ name: 'sb-access-token', value: 'abc' }, { name: 'isaflow_csrf', value: 'tok' }]);

    await ctx.get('/page', { headers: { 'x-csrf-token': 'tok' } });
    expect(seen[1]!.cookie).toBe('sb-access-token=abc; isaflow_csrf=tok');

    await ctx.post('/logout');
    expect((await ctx.storageState()).cookies).toEqual([{ name: 'isaflow_csrf', value: 'tok' }]);
  });
});
