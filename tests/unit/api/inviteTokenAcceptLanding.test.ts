/**
 * POST /api/invite/[token] — the signed-in Join. It used to set only an
 * ff_onboarding_done cookie (by hand, without the shared cookie domain) and no
 * active company, so a member of other companies joined and then landed in
 * the company they were already in (PR #908 architecture review). It now
 * lands them in the company just joined, as /api/invitations/<t>/accept does,
 * unless that company is no longer live.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({ live: true, queries: [] as string[] }));

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: logger, apiLogger: logger };
});
vi.mock('@/lib/auth/withUserAuth', () => ({
  withUserAuth: (handler: (q: NextApiRequest, s: NextApiResponse) => unknown) => (q: NextApiRequest, s: NextApiResponse) => {
    (q as unknown as { user: unknown }).user = { id: 'u-1', email: 'invitee@example.test', claims: {} };
    return handler(q, s);
  },
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/lib/auth/liveCompanies', () => ({ isLiveCompanyForUser: vi.fn(async () => h.live) }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminPool: () => ({
    connect: async () => ({
      async query(text: string) {
        h.queries.push(text);
        if (/FROM company_invitations/.test(text)) {
          return { rows: [{ id: 'inv-1', company_id: 'co-joined', email: 'invitee@example.test', role: 'viewer' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release() { /* pooled */ },
    }),
  }),
}));

const { default: handler } = await import('../../../pages/api/invite/[token]');

async function join(): Promise<{ status: number; cookies: string[] }> {
  const headers: Record<string, unknown> = {};
  const out = { status: 200, cookies: [] as string[] };
  const res = {
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    status(code: number) { out.status = code; return this; },
    json() { return this; },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', query: { token: 'raw-invite-token-0123456789' }, body: {}, headers: {}, cookies: {} } as unknown as NextApiRequest;
  await handler(req, res);
  const set = headers['set-cookie'];
  out.cookies = Array.isArray(set) ? set.map(String) : set ? [String(set)] : [];
  return out;
}

beforeEach(() => { h.live = true; h.queries.length = 0; });

describe('POST /api/invite/[token] — where the member lands', () => {
  it('in the company just joined, past the onboarding redirect', async () => {
    const { status, cookies } = await join();

    expect(status).toBe(200);
    expect(cookies.some((c) => c.startsWith('active_company_id=co-joined;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('ff_onboarding_done=1;'))).toBe(true);
    expect(h.queries.some((q) => /INSERT INTO company_users/.test(q))).toBe(true);
  });

  it('a company that is no longer live is not made active, and onboarding is not skipped', async () => {
    h.live = false;

    const { status, cookies } = await join();

    expect(status).toBe(200);
    expect(cookies.some((c) => c.startsWith('active_company_id='))).toBe(false);
    expect(cookies.some((c) => c.startsWith('ff_onboarding_done='))).toBe(false);
  });
});
