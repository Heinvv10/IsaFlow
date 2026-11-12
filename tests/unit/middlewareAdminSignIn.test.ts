// Audit P2.5 #7: /admin on the app host bounces to the admin host's sign-in. The
// admin session stays separate; only the admin host's /login is rewritten to the
// admin-branded page, so the redirect chain itself is unchanged.
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '../../middleware';

async function run(url: string, cookie?: string) {
  const headers: Record<string, string> = { host: new URL(url).host };
  if (cookie) headers.cookie = cookie;
  return middleware(new NextRequest(url, { headers }));
}

describe('admin sign-in routing', () => {
  it('app host /admin/* with an app session still redirects to the admin host', async () => {
    const res = await run('https://app.isaflow.co.za/admin/companies', 'sb-access-token=x');
    expect(res.headers.get('location')).toBe('https://admin.isaflow.co.za/companies');
  });

  it('admin host page without a session still redirects to /login with returnTo', async () => {
    const res = await run('https://admin.isaflow.co.za/companies');
    expect(res.headers.get('location')).toBe('https://admin.isaflow.co.za/login?returnTo=%2Fcompanies');
  });

  it('admin host /login is rewritten to the admin sign-in page, keeping the query', async () => {
    const res = await run('https://admin.isaflow.co.za/login?returnTo=%2Fcompanies');
    const rewrite = res.headers.get('x-middleware-rewrite') ?? '';
    expect(new URL(rewrite).pathname).toBe('/console-sign-in');
    expect(new URL(rewrite).searchParams.get('returnTo')).toBe('/companies');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('admin host /login with a session cookie is still rewritten, not gated', async () => {
    const res = await run('https://admin.isaflow.co.za/login', 'sb-access-token=x');
    expect(new URL(res.headers.get('x-middleware-rewrite') ?? '').pathname).toBe('/console-sign-in');
    expect(res.headers.get('location')).toBeNull();
  });

  it('app host /login is not rewritten', async () => {
    const res = await run('https://app.isaflow.co.za/login');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
  });

  it.each(['app.isaflow.co.za', 'isaflow.co.za'])('%s /console-sign-in redirects to that host /login', async (h) => {
    const res = await run(`https://${h}/console-sign-in`);
    expect(res.headers.get('location')).toBe(`https://${h}/login`);
  });
});
