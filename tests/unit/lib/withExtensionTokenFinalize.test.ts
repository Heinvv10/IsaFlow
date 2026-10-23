/**
 * withExtensionToken mirrors withAuth.ts's post-handler finalize logic:
 * res.statusCode >= 500 -> ROLLBACK (afterCommit hooks skipped), else COMMIT
 * (afterCommit hooks drained). Fix round 1, Task 7 finding 1 — previously
 * this wrapper COMMITted unconditionally after the handler returned, so a
 * withErrorHandler-caught fault (which answers 500 and returns normally,
 * rather than throwing) committed a partial batch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';

const h = vi.hoisted(() => ({ events: [] as string[], failCommit: false, failRollback: false, role: 'manager' }));
const client = {
  query: vi.fn(async (text: string) => {
    const verb = String(text).trim().split(/\s+/)[0]!.toUpperCase();
    if (/FROM company_users/i.test(String(text))) {
      // The pairer is a manager in good standing (S-06b standing recheck).
      return { rows: [{ role: h.role, account_user_id: 'user-1', is_active: true, status: 'active', suspended_at: null }] };
    }
    if (/FROM bank_feed_connections/i.test(String(text))) {
      return { rows: [{ id: 'conn-1', company_id: 'company-1', bank_account_id: 'ba-1', provider: 'extension', is_active: true }] };
    }
    if (verb === 'COMMIT' || verb === 'ROLLBACK') h.events.push(verb);
    if (verb === 'COMMIT' && h.failCommit) throw new Error('could not serialize access');
    if (verb === 'ROLLBACK' && h.failRollback) throw new Error('connection terminated');
    return { rows: [] };
  }),
  release: vi.fn(),
};
vi.mock('pg', () => {
  class Pool { connect = async () => client; on = vi.fn(); end = vi.fn(); }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/extensionJwt', () => ({
  verifyExtensionToken: vi.fn(async () => ({ userId: 'user-1', companyId: 'company-1', connectionId: 'conn-1', bankId: 'fnb' })),
}));

import { runAfterCommit } from '@/lib/afterCommit';
import { withExtensionToken } from '@/lib/auth/withExtensionToken';

/**
 * A minimal NextApiResponse stand-in. `json` funnels through `end`, as Next's
 * does, so the wrapper's deferred flush is exercised; `end` records when the
 * client would actually receive bytes.
 */
function res() {
  return {
    statusCode: 200,
    headersSent: false,
    body: undefined as string | undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { return this.end(JSON.stringify(b)); },
    setHeader() { return this; },
    removeHeader() { /* a replaced answer drops the route's Set-Cookie / Location */ },
    end(chunk?: string) { h.events.push(`END:${this.statusCode}`); this.body = chunk; return this; },
  };
}
const req = () => ({ headers: { authorization: 'Bearer ext_x' }, query: {} }) as never;
const queue = () => runAfterCommit('probe', async () => { h.events.push('CALLBACK'); });
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  h.events.length = 0;
  h.failCommit = false;
  h.failRollback = false;
  h.role = 'manager';
  client.release.mockClear();
  vi.stubEnv('DATABASE_URL', 'postgresql://dummy:dummy@dummy/test');
});

describe('withExtensionToken finalize (mirrors withAuth)', () => {
  it('handler answers 500 without throwing -> ROLLBACK, no COMMIT, afterCommit not drained', async () => {
    const handled = withExtensionToken(async (_req: never, r: ReturnType<typeof res>) => {
      queue();
      r.status(500).json({ success: false });
    });
    const response = res();
    await handled(req(), response as never);
    await settle();
    expect(h.events).toEqual(['ROLLBACK', 'END:500']);
    expect(h.events).not.toContain('COMMIT');
    expect(h.events).not.toContain('CALLBACK');
  });

  it('handler answers 200 -> COMMIT, then the response flushes, then afterCommit drains', async () => {
    const handled = withExtensionToken(async (_req: never, r: ReturnType<typeof res>) => {
      queue();
      r.status(200).json({ success: true });
    });
    const response = res();
    await handled(req(), response as never);
    await settle();
    expect(h.events).toEqual(['COMMIT', 'END:200', 'CALLBACK']);
  });

  it('COMMIT throws after the handler answered 200 -> the client gets 500 COMMIT_FAILED, not the 200 (A-5)', async () => {
    h.failCommit = true;
    const handled = withExtensionToken(async (_req: never, r: ReturnType<typeof res>) => {
      queue();
      r.status(200).json({ success: true, data: { imported: 3 } });
    });
    const response = res();
    await handled(req(), response as never);
    await settle();
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({ success: false, code: 'COMMIT_FAILED' });
    expect(h.events).toEqual(['COMMIT', 'ROLLBACK', 'END:500']);
    expect(h.events).not.toContain('END:200');
    expect(h.events).not.toContain('CALLBACK');
  });

  it('handler throws -> ROLLBACK, then the wrapper itself answers 500 (R-159: it used to rethrow into its own buffer)', async () => {
    const handled = withExtensionToken(async () => {
      queue();
      throw new Error('body failed');
    });
    const response = res();
    await expect(handled(req(), response as never)).resolves.toBeUndefined();
    await settle();
    expect(h.events).toEqual(['ROLLBACK', 'END:500']);
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({ success: false, code: 'INTERNAL_SERVER_ERROR' });
  });

  // S-06b: the standing refusal answers 401 itself; the handler never runs and nothing commits.
  it.each([false, true])('a pairer below manager -> ROLLBACK, 401, handler not run (ROLLBACK fails: %s -> connection destroyed)', async (failRollback) => {
    h.role = 'viewer';
    h.failRollback = failRollback;
    const handler = vi.fn();
    const response = res();
    await withExtensionToken(handler)(req(), response as never);
    expect(handler).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body ?? '{}')).toEqual({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or revoked pairing token' } });
    expect(h.events).toEqual(['ROLLBACK', 'END:401']);
    expect(client.release).toHaveBeenCalledWith(failRollback);
  });
});
