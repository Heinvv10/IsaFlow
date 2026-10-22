/**
 * Audit S-08 follow-up (item C) — the AFS portal pages are for outside
 * directors, who have no staff login. Middleware must let them through without
 * the staff cookie; each page's getServerSideProps (verifyPortalToken +
 * currentPortalSession) is the gate. The staff page /accounting/afs/portal-contacts
 * shares the prefix without the trailing slash and must stay staff-only.
 */

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '../../middleware';

const run = (path: string) => {
  const url = `https://app.isaflow.co.za${path}`;
  return middleware(new NextRequest(url, { headers: { host: 'app.isaflow.co.za' } }));
};

const loginRedirectOf = async (path: string) => {
  const location = (await run(path)).headers.get('location');
  return location ? new URL(location).pathname : null;
};

describe('middleware — AFS portal pages are public, portal-contacts is not', () => {
  it.each([
    '/accounting/afs/portal/login',
    '/accounting/afs/portal/login?error=expired',
    '/accounting/afs/portal/dashboard',
    '/accounting/afs/portal/documents/d1',
  ])('%s with no cookie passes through', async (path) => {
    const res = await run(path);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it.each([
    '/accounting/afs/portal-contacts',
    '/accounting/afs/portal',
    '/accounting/afs',
  ])('%s with no cookie redirects to /login', async (path) => {
    expect(await loginRedirectOf(path)).toBe('/login');
  });
});
