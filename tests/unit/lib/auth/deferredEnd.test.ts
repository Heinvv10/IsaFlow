/**
 * R-159 — answerThrow reports a throw to Sentry with the tenant it happened in. The wrappers
 * call it outside the Sentry isolation scope that carried the tenant tags, so the tags have to
 * travel with the capture. The route, write and rollback behaviour is proven against Postgres in
 * tests/integration/r159-auth-wrapper-throw-responds.int.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { answerInstead, answerThrow, deferEnd, reportFinalizeFailure } from '@/lib/auth/deferredEnd';
import { log } from '@/lib/logger';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';

function res() {
  const ends: unknown[][] = [];
  const r = {
    statusCode: 200, headersSent: false, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    setHeader(k: string, v: unknown) { this.headers[k.toLowerCase()] = v; return this; },
    removeHeader(k: string) { delete this.headers[k.toLowerCase()]; },
    json(b: unknown) { return this.end(JSON.stringify(b)); },
    end(...a: unknown[]) { ends.push(a); return this; },
  };
  return { r, ends };
}
const req = { url: '/api/invitations/revoke/abc?x=1' } as never;

afterEach(() => { vi.unstubAllEnvs(); h.captureException.mockReset(); });

describe('answerThrow', () => {
  it('captures to Sentry with the company, route and user when Sentry is on', () => {
    vi.stubEnv('SENTRY_ENABLED', 'true');
    const { r } = res();
    const err = new Error('boom');
    answerThrow(req, r as never, deferEnd(r as never), err, { source: 'withAuth', companyId: 'co-1', userId: 'u-1' });
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledWith(err, {
      tags: { company_id: 'co-1', route: '/api/invitations/revoke/abc' },
      user: { id: 'u-1' },
    });
  });

  it('a Sentry capture that throws does not stop the answer', () => {
    vi.stubEnv('SENTRY_ENABLED', 'true');
    h.captureException.mockImplementationOnce(() => { throw new Error('sentry down'); });
    const { r, ends } = res();
    expect(() => answerThrow(req, r as never, deferEnd(r as never), new Error('boom'), { source: 'withAuth' })).not.toThrow();
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
  });

  it('does not capture when Sentry is off', () => {
    const { r } = res();
    answerThrow(req, r as never, deferEnd(r as never), new Error('boom'), { source: 'withAuth' });
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('a refused Login-as session is answered 403 through the real end, as withErrorHandler answers it', () => {
    const { r, ends } = res();
    answerThrow(req, r as never, deferEnd(r as never), new ImpersonationForbiddenError(), { source: 'withAuth' });
    expect(r.statusCode).toBe(403);
    expect(ends).toHaveLength(1);
    expect(JSON.parse(String(ends[0]![0]))).toMatchObject({ success: false });
  });

  it('in production the 500 masks the error text and carries no details', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { r, ends } = res();
    answerThrow(req, r as never, deferEnd(r as never), new Error('relation "secret_table" does not exist'), { source: 'withAuth' });
    expect(r.statusCode).toBe(500);
    const body = JSON.parse(String(ends[0]![0]));
    expect(body).toEqual({ success: false, data: null, message: 'An unexpected error occurred', code: 'INTERNAL_SERVER_ERROR' });
  });

  it('an error whose message getter throws is still answered 500 once, and nothing escapes', () => {
    const { r, ends } = res();
    const err = new Error('x');
    Object.defineProperty(err, 'message', { get() { throw new Error('getter'); } });
    expect(() => answerThrow(req, r as never, deferEnd(r as never), err, { source: 'withAuth' })).not.toThrow();
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
    expect(JSON.parse(String(ends[0]![0]))).toMatchObject({ success: false, code: 'INTERNAL_SERVER_ERROR' });
  });

  it('a thrown value that cannot be printed is still answered 500 once, and nothing escapes', () => {
    const { r, ends } = res();
    expect(() => answerThrow(req, r as never, null, Object.create(null), { source: 'withAuth' })).not.toThrow();
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
  });

  it('a response that already ended through the real end is neither aborted nor ended again', () => {
    const destroy = vi.fn();
    const { r, ends } = res();
    Object.assign(r, { headersSent: true, writableEnded: true, destroy });
    answerThrow(req, r as never, null, new Error('after the send'), { source: 'withAuth' });
    expect(destroy).not.toHaveBeenCalled();
    expect(ends).toHaveLength(0);
  });

  it('headers sent but not ended: the response is aborted, not ended', () => {
    const destroy = vi.fn();
    const { r, ends } = res();
    Object.assign(r, { headersSent: true, writableEnded: false, destroy });
    answerThrow(req, r as never, null, new Error('mid-stream'), { source: 'withAuth' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(ends).toHaveLength(0);
  });

  it('with no deferral (a throw before the swap) it still answers 500 once', () => {
    const { r, ends } = res();
    answerThrow(req, r as never, null, new Error('boom'), { source: 'withAuth' });
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
  });
});

describe('sec-numrace F1: a replaced answer drops the Set-Cookie and Location the route set', () => {
  /** What a route such as impersonate sets before answering 200, plus a header the wrapper set. */
  const routeAnswered = () => {
    const { r, ends } = res();
    const deferred = deferEnd(r as never);
    r.setHeader('Cache-Control', 'private, no-store');
    r.setHeader('Set-Cookie', ['sb-access-token=TARGET; HttpOnly', 'impersonation_proof=PROOF']);
    r.setHeader('Location', '/accounting');
    r.status(200).json({ ok: true });
    return { r, ends, deferred };
  };

  it('answerInstead (the commit-failed and audit-failed 500s)', () => {
    const { r, ends, deferred } = routeAnswered();
    answerInstead(r as never, deferred, 500, { success: false, code: 'COMMIT_FAILED' });
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
    expect(r.headers).not.toHaveProperty('set-cookie');
    expect(r.headers).not.toHaveProperty('location');
    expect(r.headers['cache-control']).toBe('private, no-store');
  });

  it('answerThrow (a throw inside the transaction)', () => {
    const { r, ends, deferred } = routeAnswered();
    answerThrow(req, r as never, deferred, new Error('boom'), { source: 'withPlatformAdmin' });
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
    expect(r.headers).not.toHaveProperty('set-cookie');
    expect(r.headers).not.toHaveProperty('location');
    expect(r.headers['cache-control']).toBe('private, no-store');
  });
});

describe('reportFinalizeFailure (R-176)', () => {
  const ctx = { source: 'withAuth', companyId: 'co-1', userId: 'u-1', handlerFailed: true, connectionDestroyed: true };

  it('logs the request under the message an alert watches, with the tenant and what failed', () => {
    const { r } = res();
    r.statusCode = 503;
    vi.mocked(log.error).mockClear();
    reportFinalizeFailure(req, r as never, new Error('ROLLBACK did not answer'), { ...ctx, extra: { connectionId: 'c-1' } });
    expect(vi.mocked(log.error).mock.calls).toEqual([['withAuth: transaction finalize failed after handler responded', {
      url: '/api/invitations/revoke/abc', status: 503, handlerFailed: true, connectionDestroyed: true,
      companyId: 'co-1', userId: 'u-1', connectionId: 'c-1', message: 'ROLLBACK did not answer',
    }, 'Auth']]);
  });

  it('never logs the query string: some routes carry a secret there', () => {
    vi.mocked(log.error).mockClear();
    const whatsapp = { url: '/api/accounting/capture/inbound/whatsapp?token=s3cr3t-inbound-key&x=1' } as never;
    reportFinalizeFailure(whatsapp, res().r as never, new Error('COMMIT refused'), ctx);
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('s3cr3t');
    expect(vi.mocked(log.error).mock.calls[0]![1]).toMatchObject({ url: '/api/accounting/capture/inbound/whatsapp' });
  });

  it('captures to Sentry with the tenant when Sentry is on, and not when it is off', () => {
    const err = new Error('COMMIT refused');
    reportFinalizeFailure(req, res().r as never, err, ctx);
    expect(h.captureException).not.toHaveBeenCalled();
    vi.stubEnv('SENTRY_ENABLED', 'true');
    reportFinalizeFailure(req, res().r as never, err, ctx);
    expect(h.captureException.mock.calls).toEqual([[err, {
      tags: { company_id: 'co-1', route: '/api/invitations/revoke/abc' }, user: { id: 'u-1' },
    }]]);
  });

  it('a Sentry capture that throws does not escape: the wrapper still has a response to send', () => {
    vi.stubEnv('SENTRY_ENABLED', 'true');
    h.captureException.mockImplementationOnce(() => { throw new Error('sentry down'); });
    expect(() => reportFinalizeFailure(req, res().r as never, new Error('x'), ctx)).not.toThrow();
  });

  it('keeps the wrapper\'s own log component when it has one', () => {
    vi.mocked(log.error).mockClear();
    reportFinalizeFailure(req, res().r as never, 'not an Error', { ...ctx, component: 'extensionAuth' });
    expect(vi.mocked(log.error).mock.calls[0]![2]).toBe('extensionAuth');
    expect(vi.mocked(log.error).mock.calls[0]![1]).toMatchObject({ message: 'not an Error' });
  });
});
