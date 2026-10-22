/**
 * Audit S-08 — the AFS portal pages re-read a session's standing server-side
 * (currentPortalSession), not only its 8-hour JWT: a session whose company was
 * suspended or whose contact was deactivated is sent to the login page, and
 * the document page judges annotation by the contact's CURRENT role.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@/lib/auth/portalJwt', () => ({
  verifyPortalToken: async () => ({ contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' }),
}));
vi.mock('@/lib/auth/portalAuth', () => ({ currentPortalSession: vi.fn(async () => h.current) }));

import { getServerSideProps as dashboardProps } from '../../../pages/accounting/afs/portal/dashboard';
import { getServerSideProps as documentProps } from '../../../pages/accounting/afs/portal/documents/[documentId]';

const ctx = { req: { cookies: { portal_session: 'tok' } }, params: { documentId: 'd1' } } as never;
const EXPIRED = { redirect: { destination: '/accounting/afs/portal/login?error=expired', permanent: false } };

beforeEach(() => {
  h.current = null;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    data: { documents: [], document: { id: 'd1' }, sections: [] },
  }), { status: 200 })));
});

describe('AFS portal pages — server-side session standing', () => {
  it('sends a session no longer in standing to the login page (dashboard)', async () => {
    expect(await dashboardProps(ctx)).toEqual(EXPIRED);
  });

  it('sends a session no longer in standing to the login page (document)', async () => {
    expect(await documentProps(ctx)).toEqual(EXPIRED);
  });

  it.each([
    ['dashboard', dashboardProps],
    ['document', documentProps],
  ] as const)('a staff cookie without a portal session is sent to the login page (%s)', async (_, props) => {
    const staffOnly = { req: { cookies: { 'sb-access-token': 'staff' } }, params: { documentId: 'd1' } } as never;
    expect(await props(staffOnly)).toEqual({
      redirect: { destination: '/accounting/afs/portal/login', permanent: false },
    });
  });

  it('encodes the document id into the server-side fetch: a ../ cannot re-point it', async () => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' };
    const traversal = { req: { cookies: { portal_session: 'tok' } }, params: { documentId: '../../reports/x' } } as never;
    await documentProps(traversal);
    const url = new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]));
    expect(url.pathname).toBe('/api/accounting/portal/documents/..%2F..%2Freports%2Fx');
  });

  it("judges annotation by the contact's current role, not the JWT's", async () => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'shareholder_readonly', expiresAt: '' };
    const res = await documentProps(ctx) as { props: { canAnnotate: boolean } };
    expect(res.props.canAnnotate).toBe(false);
  });
});
