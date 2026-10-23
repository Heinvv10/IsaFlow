/**
 * AFS portal Sign out is a plain HTML form POST. The route must send the
 * browser to the portal login page (303, so it follows with a GET), never
 * leave the director on a raw JSON page. A foreign Origin clears nothing and
 * lands on the login page without the signed-out notice. The target is a
 * constant: nothing in the request can re-point it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logger')>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/portal/auth/logout';

const APP = 'https://app.example.test';

type Out = { status: number; location?: string; cookies: string[]; body?: unknown };

async function call(method: string, headers: Record<string, string>, query: Record<string, string> = {}): Promise<Out> {
  const out: Out = { status: 0, cookies: [] };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; if (!out.status) out.status = 200; return res; },
    send(b: unknown) { out.body = b; return res; },
    end() { return res; },
    redirect(c: number, url: string) { out.status = c; out.location = url; return res; },
    setHeader(name: string, v: string | string[]) {
      if (name.toLowerCase() === 'set-cookie') out.cookies.push(...([] as string[]).concat(v));
      if (name.toLowerCase() === 'location') out.location = String(v);
      return res;
    },
    getHeader: vi.fn(),
    headersSent: false,
  };
  await (handler as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(
    { method, headers, query, body: {}, url: '/api/accounting/portal/auth/logout' } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return out;
}

const clearsSession = (c: string[]) => c.some((v) => /^portal_session=;/.test(v) && /Max-Age=0/.test(v));

beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_APP_URL', APP); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/accounting/portal/auth/logout', () => {
  it('from the app: 303 to the login page with the signed-out notice, and clears portal_session', async () => {
    const out = await call('POST', { origin: APP });
    expect(out.status).toBe(303);
    expect(out.location).toBe('/accounting/afs/portal/login?signed_out=1');
    expect(clearsSession(out.cookies)).toBe(true);
    expect(out.body).toBeUndefined();
  });

  it('with no Origin header (non-browser client): still signs out and redirects', async () => {
    const out = await call('POST', {});
    expect(out.status).toBe(303);
    expect(out.location).toBe('/accounting/afs/portal/login?signed_out=1');
    expect(clearsSession(out.cookies)).toBe(true);
  });

  it.each([['foreign site', 'https://evil.example'], ['opaque origin', 'null']])(
    'refuses a %s Origin: clears nothing, lands on the login page without the notice', async (_, origin) => {
      const out = await call('POST', { origin });
      expect(out.status).toBe(303);
      expect(out.location).toBe('/accounting/afs/portal/login');
      expect(out.cookies).toEqual([]);
    });

  it('takes no redirect target from the request', async () => {
    const out = await call('POST', { origin: APP, referer: 'https://evil.example/x' },
      { returnTo: 'https://evil.example', next: '//evil.example', redirect: 'https://evil.example' });
    expect(out.location).toBe('/accounting/afs/portal/login?signed_out=1');
  });

  it('GET is 405 and clears nothing', async () => {
    const out = await call('GET', { origin: APP });
    expect(out.status).toBe(405);
    expect(out.cookies).toEqual([]);
  });
});
