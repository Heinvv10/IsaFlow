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

import { answerThrow, deferEnd } from '@/lib/auth/deferredEnd';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';

function res() {
  const ends: unknown[][] = [];
  const r = {
    statusCode: 200, headersSent: false,
    status(c: number) { this.statusCode = c; return this; },
    setHeader() { return this; },
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

  it('an error whose message cannot be read is still answered 500 once, and nothing escapes', () => {
    const { r, ends } = res();
    const deferred = deferEnd(r as never);
    const err = new Error('x');
    Object.defineProperty(err, 'message', { get() { throw new Error('getter'); } });
    expect(() => answerThrow(req, r as never, deferred, err, { source: 'withAuth' })).not.toThrow();
    expect(() => answerThrow(req, r as never, null, Object.create(null), { source: 'withAuth' })).not.toThrow();
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(2);
    expect(JSON.parse(String(ends[0]![0]))).toMatchObject({ success: false, code: 'INTERNAL_SERVER_ERROR' });
  });

  it('with no deferral (a throw before the swap) it still answers 500 once', () => {
    const { r, ends } = res();
    answerThrow(req, r as never, null, new Error('boom'), { source: 'withAuth' });
    expect(r.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
  });
});
