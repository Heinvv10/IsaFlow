/**
 * callApiInProcess runs a Next API handler in this process (no HTTP) against a page's request and returns
 * what the handler answered. A page's getServerSideProps used to fetch its own API through
 * NEXT_PUBLIC_APP_URL; this is the replacement, so what matters is: the handler sees the caller's cookies,
 * the status and JSON body come back, a throw becomes the handler's own 500 answer, and nothing touches fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { callApiInProcess } from '@/lib/auth/callApiInProcess';

const pageReq = (cookie = 'a=1; sb-access-token=tok') => ({ headers: { cookie, host: 'dev.test:3201' }, socket: { remoteAddress: '10.0.0.1' } }) as unknown as IncomingMessage;

afterEach(() => { vi.unstubAllGlobals(); });

describe('callApiInProcess', () => {
  it('hands the handler a GET with the given url, query and the caller cookies; returns status and body', async () => {
    let seen: Partial<NextApiRequest> = {};
    const out = await callApiInProcess(async (req: NextApiRequest, res: NextApiResponse) => {
      seen = { method: req.method, url: req.url, query: req.query, headers: req.headers };
      res.status(200).json({ success: true, data: { ok: 1 } });
    }, pageReq(), { url: '/api/x/7', query: { id: '7' } });
    expect(out).toEqual({ status: 200, body: { success: true, data: { ok: 1 } } });
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/api/x/7');
    expect(seen.query).toEqual({ id: '7' });
    expect(seen.headers?.cookie).toContain('sb-access-token=tok');
  });

  it('a non-2xx answer comes back with its status', async () => {
    const out = await callApiInProcess((_req: NextApiRequest, res: NextApiResponse) => { res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } }); },
      pageReq(), { url: '/api/x/7', query: {} });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('a handler that sets headers and ends without a body answers an empty body', async () => {
    const out = await callApiInProcess((_req: NextApiRequest, res: NextApiResponse) => { res.setHeader('X-A', '1'); res.status(204).end(); },
      pageReq(), { url: '/api/x', query: {} });
    expect(out).toEqual({ status: 204, body: null });
  });

  it('a handler that throws is rethrown to the page, not swallowed into a 200', async () => {
    await expect(callApiInProcess(() => { throw new Error('boom'); }, pageReq(), { url: '/api/x', query: {} })).rejects.toThrow('boom');
  });

  it('a handler that never answers is an error, not an empty success', async () => {
    await expect(callApiInProcess(async () => undefined, pageReq(), { url: '/api/x', query: {} })).rejects.toThrow(/did not answer/);
  });

  it('makes no HTTP call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await callApiInProcess((_req: NextApiRequest, res: NextApiResponse) => { res.status(200).json({}); }, pageReq(), { url: '/api/x', query: {} });
    expect(f).not.toHaveBeenCalled();
  });
});
