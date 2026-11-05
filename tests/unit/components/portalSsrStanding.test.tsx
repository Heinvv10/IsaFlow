/**
 * Audit S-08 — the AFS portal pages re-read a session's standing server-side
 * (currentPortalSession), not only its 8-hour JWT: a session whose company was
 * suspended or whose contact was deactivated is sent to the login page, and
 * the document page judges annotation by the contact's CURRENT role.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  current: null as unknown,
  list: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  load: vi.fn(async (..._a: unknown[]) => ({ kind: 'ok', document: { id: 'd1' }, sections: [] }) as unknown),
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@/lib/auth/portalJwt', () => ({
  verifyPortalToken: async () => ({ contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' }),
}));
vi.mock('@/modules/accounting/services/afs/portalDocumentService', () => ({ listPortalDocuments: h.list, loadPortalDocument: h.load }));
vi.mock('@/lib/auth/portalAuth', () => ({ currentPortalSession: vi.fn(async () => h.current) }));

import { getServerSideProps as dashboardProps } from '../../../pages/accounting/afs/portal/dashboard';
import { getServerSideProps as documentProps } from '../../../pages/accounting/afs/portal/documents/[documentId]';

const ctx = { req: { cookies: { portal_session: 'tok' } }, params: { documentId: 'd1' } } as never;
const EXPIRED = { redirect: { destination: '/accounting/afs/portal/login?error=expired', permanent: false } };

beforeEach(() => {
  h.current = null;
  h.list.mockClear(); h.load.mockClear();
  // The pages call the service in this process: a fetch of their own API would be a regression.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the page must not fetch its own API'); }));
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

  it('reads the document with the verified session company and CURRENT role, never from the request', async () => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' };
    await documentProps(ctx);
    expect(h.load).toHaveBeenCalledWith('co-1', 'director', 'd1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a document id that is not a document (a ../ path, a failed read) goes back to the dashboard, never to an error', async () => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' };
    h.load.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
    const traversal = { req: { cookies: { portal_session: 'tok' } }, params: { documentId: '../../reports/x' } } as never;
    expect(await documentProps(traversal)).toEqual({ redirect: { destination: '/accounting/afs/portal/dashboard', permanent: false } });
    expect(h.load).toHaveBeenCalledWith('co-1', 'director', '../../reports/x');
  });

  it.each([{ kind: 'not_found' }, { kind: 'forbidden', message: 'no' }])('a %o answer goes back to the dashboard', async (outcome) => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' };
    h.load.mockResolvedValueOnce(outcome);
    expect(await documentProps(ctx)).toEqual({ redirect: { destination: '/accounting/afs/portal/dashboard', permanent: false } });
  });

  it('lists with the session company and current role, and the props survive JSON (Date columns become strings)', async () => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' };
    h.list.mockResolvedValueOnce([{ id: 'd1', created_at: new Date('2026-11-01T10:00:00Z') }]);
    const res = await dashboardProps(ctx) as { props: { documents: Array<{ created_at: unknown }>; loadError: string } };
    expect(h.list).toHaveBeenCalledWith('co-1', 'director');
    expect(res.props.documents[0]!.created_at).toBe('2026-11-01T10:00:00.000Z');
    expect(res.props.loadError).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a failed list is the load error, not a crash', async () => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' };
    h.list.mockRejectedValueOnce(new Error('db down'));
    const res = await dashboardProps(ctx) as { props: { documents: unknown[]; loadError: string } };
    expect(res.props).toMatchObject({ documents: [], loadError: 'Could not load your documents - try again' });
  });

  it("judges annotation by the contact's current role, not the JWT's", async () => {
    h.current = { contactId: 'c1', companyId: 'co-1', role: 'shareholder_readonly', expiresAt: '' };
    const res = await documentProps(ctx) as { props: { canAnnotate: boolean } };
    expect(res.props.canAnnotate).toBe(false);
  });
});
