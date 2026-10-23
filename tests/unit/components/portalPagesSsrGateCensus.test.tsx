/**
 * Audit S-08 follow-up C: middleware lets every page under
 * pages/accounting/afs/portal/ through without a staff login (PUBLIC_PATHS
 * '/accounting/afs/portal/'), so each page must gate itself. Every page found
 * there but the login page is imported and its getServerSideProps CALLED with
 * no cookie, a staff cookie only, a portal token that does not verify, and a
 * token that verifies but whose standing is gone (currentPortalSession null:
 * the S-08 re-read): each must redirect to the portal login, never render. A
 * new page without that gate (or with none at all) fails here. Judged by
 * outcome, not text. Named limit: each page is called with one param value
 * and an empty query; a page that renders only for another value is not seen.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: () => null }));
// 'valid' verifies; any other token does not. Standing is always gone.
const SESSION = { contactId: 'c1', companyId: 'co-1', role: 'director', expiresAt: '' };
vi.mock('@/lib/auth/portalJwt', () => ({ verifyPortalToken: vi.fn(async (t: string) => (t === 'valid' ? SESSION : null)) }));
vi.mock('@/lib/auth/portalAuth', () => ({ currentPortalSession: vi.fn(async () => null) }));

const ROOT = join(__dirname, '../../../pages/accounting/afs/portal');
const PUBLIC_PAGES = ['login.tsx'];

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? pages(path) : /\.(tsx|ts|jsx|js)$/.test(name) ? [path] : [];
  });
}

const found = pages(ROOT).map((p) => relative(ROOT, p)).sort();
const LOGIN = '/accounting/afs/portal/login';

describe('AFS portal pages gate themselves server-side', () => {
  it('the census sees the portal pages', () => {
    expect(found).toEqual(expect.arrayContaining(['dashboard.tsx', 'documents/[documentId].tsx', 'login.tsx']));
  });

  it.each(found.filter((p) => !PUBLIC_PAGES.includes(p)))('%s redirects to the portal login without a valid portal session', async (page) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const mod = (await import(join(ROOT, page))) as { getServerSideProps?: (ctx: never) => Promise<unknown> };
    expect(typeof mod.getServerSideProps, 'exports getServerSideProps').toBe('function');
    const call = (cookies: Record<string, string>) =>
      mod.getServerSideProps!({ req: { cookies }, params: { documentId: 'd1' }, query: {} } as never) as Promise<{ redirect?: { destination: string } }>;
    for (const cookies of [{}, { 'sb-access-token': 'staff' }, { portal_session: 'forged' }, { portal_session: 'valid' }]) {
      const out = await call(cookies);
      expect(out.redirect?.destination?.startsWith(LOGIN), `${page} with ${JSON.stringify(cookies)}`).toBe(true);
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
