import type { NextApiRequest, NextApiResponse } from 'next';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';

export function assertDisposable() {
  if (process.env.ISAFLOW_DISPOSABLE_AUTH_TEST !== '1') throw new Error('Disposable auth opt-in required');
  // The database URLs through the parser pg uses (fixtureDbGuard): a `?host=`
  // in the query string otherwise overrides the localhost a URL check sees.
  for (const name of ['DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL']) {
    assertLocalFixtureDbUrl(name, process.env[name], ['isaflow_schema_fixture']);
  }
  const gotrue = new URL(process.env.GOTRUE_URL ?? 'http://missing.invalid');
  if (!['localhost', '127.0.0.1'].includes(gotrue.hostname)) throw new Error('GOTRUE_URL must be localhost');
}
/**
 * `url`'s path below GOTRUE_URL's own path, for fetch stubs standing in for
 * GoTrue: a Supabase-style GOTRUE_URL carries a path (`…/auth/v1`), so the
 * app requests `/auth/v1/admin/users`, not `/admin/users`.
 */
export function gotruePath(url: URL): string {
  const base = new URL(process.env.GOTRUE_URL ?? 'http://localhost').pathname.replace(/\/$/, '');
  return url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
}

export function request(jar: Record<string, string>, method: string, targetId?: string) {
  const csrf = 'disposable-postgres-workflow-csrf-0123456789';
  const cookies = { ...jar, isaflow_csrf: csrf };
  return { method, url: '/api/accounting/mfa-integration-fixture', cookies,
    query: targetId ? { id: targetId } : {},
    headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': csrf, 'x-admin-request': 'true' },
    socket: { remoteAddress: '127.0.0.79' },
  } as unknown as NextApiRequest;
}
export function response() {
  const headers = new Map<string, unknown>();
  const state = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    json(body: unknown) { this.body = body; return this.end(); },
    end() { return this; },
  };
  return { res: state as unknown as NextApiResponse, state, headers };
}
export function applyCookies(jar: Record<string, string>, result: ReturnType<typeof response>) {
  for (const cookie of (result.headers.get('set-cookie') as string[] | undefined) ?? []) {
    const pair = cookie.split(';')[0]!;
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    if (/Max-Age=0(?:;|$)/i.test(cookie)) delete jar[name];
    else jar[name] = pair.slice(index + 1);
  }
}
