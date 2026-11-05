/**
 * callApiInProcess runs a Next API handler in this process (no HTTP) against a page's request and returns
 * what the handler answered. A page's getServerSideProps used to fetch its own API through
 * NEXT_PUBLIC_APP_URL; this is the replacement, so what matters is: the handler sees the caller's cookies,
 * the status and JSON body come back, a bare handler's throw is rethrown to the page (a withAuth/withErrorHandler route answers its own throws as a 500 status, which comes back as a status), and nothing touches fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { callApiInProcess } from '@/lib/auth/callApiInProcess';
import { deferEnd, replayEnd, answerThrow, answerCommitFailed } from '@/lib/auth/deferredEnd';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

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

/** The way withAuth drives the response: deferEnd swaps res.end, the answer is replayed once the transaction is final. */
describe('callApiInProcess through the withAuth response protocol (deferredEnd)', () => {
  type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
  const call = (h: Handler) => callApiInProcess(h, pageReq(), { url: '/api/x', query: {} });

  it('a deferred end replayed after the commit is the answer (status, body)', async () => {
    const out = await call(async (req, res) => {
      const flush = deferEnd(res);
      res.status(201).json({ success: true, data: { id: 'a' } });
      expect(flush.ended).toBe(true);
      replayEnd(res, flush, { source: 'test' });
    });
    expect(out).toEqual({ status: 201, body: { success: true, data: { id: 'a' } } });
  });

  it('an answer deferred and never replayed is "did not answer", not a success', async () => {
    await expect(call(async (_req, res) => { deferEnd(res); res.status(200).json({ ok: 1 }); })).rejects.toThrow(/did not answer/);
  });

  it('a throw answered by answerThrow comes back as a 500 status', async () => {
    const out = await call(async (req, res) => {
      const flush = deferEnd(res);
      try { throw new Error('boom'); } catch (err) { answerThrow(req, res, flush, err, { source: 'test' }); }
    });
    expect(out.status).toBe(500);
  });

  it('a commit failure replaces the buffered 2xx with its own 500 body (the body is replaced, not just the status)', async () => {
    const out = await call(async (_req, res) => {
      const flush = deferEnd(res);
      res.status(200).json({ success: true, data: { stale: true } });
      answerCommitFailed(res, flush);
    });
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ code: 'COMMIT_FAILED' });
    expect(JSON.stringify(out.body)).not.toContain('stale');
  });

  it('a response destroyed by the handler (an aborted answer) is an error', async () => {
    await expect(call(async (_req, res) => { res.status(200).json({ ok: 1 }); res.destroy(); })).rejects.toThrow(/aborted/);
  });
});

describe('callApiInProcess response surface', () => {
  const call = (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => callApiInProcess(h, pageReq(), { url: '/api/x', query: {} });

  it('hasHeader, getHeaders and getHeaderNames see what setHeader set, case-insensitively', async () => {
    let seen: unknown[] = [];
    await call((_req, res) => {
      res.setHeader('X-A', '1');
      seen = [res.hasHeader('x-a'), res.hasHeader('x-b'), res.getHeaders(), res.getHeaderNames()];
      res.status(200).json({});
    });
    expect(seen).toEqual([true, false, { 'x-a': '1' }, ['x-a']]);
  });

  it('writeHead + write + end assemble one JSON body', async () => {
    const out = await call((_req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.write('{"a":');
      res.end('1}');
    });
    expect(out).toEqual({ status: 202, body: { a: 1 } });
  });

  it('a ServerResponse feature it does not implement fails naming the method', async () => {
    await expect(call((_req, res) => { (res as unknown as { flushHeaders: () => void }).flushHeaders(); }))
      .rejects.toThrow(/callApiInProcess.*res\.flushHeaders/);
  });
});

