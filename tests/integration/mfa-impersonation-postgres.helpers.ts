import type { NextApiRequest, NextApiResponse } from 'next';

export function assertDisposable() {
  if (process.env.ISAFLOW_DISPOSABLE_AUTH_TEST !== '1') throw new Error('Disposable auth opt-in required');
  for (const name of ['DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'GOTRUE_URL']) {
    const url = new URL(process.env[name] ?? 'http://missing.invalid');
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error(`${name} must be localhost`);
    if (name !== 'GOTRUE_URL' && url.pathname !== '/isaflow_schema_fixture') {
      throw new Error(`${name} must use isaflow_schema_fixture`);
    }
  }
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
