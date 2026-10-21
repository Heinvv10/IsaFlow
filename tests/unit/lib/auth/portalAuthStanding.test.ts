/**
 * Audit S-08 (breaker round 2, NEW A): a portal session is re-checked on every
 * request — its company still live and its contact still active — not only
 * its JWT, which lasts 8 hours.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  session: { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' } as unknown,
  live: [{ companyId: 'co-1', companyName: 'Alpha' }] as unknown[],
  contactRows: [{ role: 'director' }] as unknown[],
}));

vi.mock('@/lib/auth/portalJwt', () => ({ verifyPortalToken: vi.fn(async () => h.session) }));
vi.mock('@/lib/auth/liveCompanies', () => ({ listLiveCompanies: vi.fn(async () => h.live) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => h.contactRows) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { withPortalAuth } from '@/lib/auth/portalAuth';

async function call() {
  const handler = vi.fn((_req: unknown, res: NextApiResponse) => res.status(200).json({ ok: true }));
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
  };
  await withPortalAuth(handler)(
    { cookies: { portal_session: 'jwt' }, url: '/api/accounting/portal/documents' } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return { out, handler };
}

beforeEach(() => {
  h.live = [{ companyId: 'co-1', companyName: 'Alpha' }];
  h.contactRows = [{ role: 'director' }];
});

describe('withPortalAuth — the session must still be in standing', () => {
  it('admits a valid session for a live company and an active contact', async () => {
    const { out, handler } = await call();
    expect(out.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses (401) a session whose company was suspended or deleted since sign-in', async () => {
    h.live = [];
    const { out, handler } = await call();
    expect(out.status).toBe(401);
    expect(JSON.stringify(out.body)).toContain('PORTAL_AUTH_INVALID');
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands the handler the contact's current role, not the one signed into the JWT", async () => {
    h.contactRows = [{ role: 'shareholder_readonly' }];
    const { handler } = await call();
    expect((handler.mock.calls[0]?.[0] as { portalSession: { role: string } }).portalSession.role).toBe('shareholder_readonly');
  });

  it('refuses (401) a session whose contact was deactivated since sign-in', async () => {
    h.contactRows = [];
    const { out, handler } = await call();
    expect(out.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
