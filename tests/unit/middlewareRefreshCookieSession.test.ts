/**
 * "Keep me signed in" lasts 30 days on the refresh cookie, but the access cookie
 * dies after an hour. A browser holding only the refresh cookie is signed in: the
 * client renews it (useSessionCheck, apiFetch). Sending it to /login signed people
 * out an hour after every login.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '../../middleware';

const REFRESH_ONLY = 'sb-refresh-token=r1; ff_onboarding_done=1';

const visit = (url: string, cookie?: string) => {
  const headers: Record<string, string> = { host: new URL(url).host };
  if (cookie) headers.cookie = cookie;
  return middleware(new NextRequest(url, { headers }));
};
const landsOn = (res: Response) => {
  const location = res.headers.get('location');
  return location ? new URL(location).pathname : null;
};

describe('a browser holding only the refresh cookie', () => {
  it.each([
    'https://app.isaflow.co.za/accounting',
    'https://app.isaflow.co.za/payroll/runs',
    'https://admin.isaflow.co.za/companies',
  ])('is not sent to /login from %s', async (url) => {
    expect(landsOn(await visit(url, REFRESH_ONLY))).toBeNull();
  });

  it('still goes through the onboarding gate', async () => {
    expect(landsOn(await visit('https://app.isaflow.co.za/accounting', 'sb-refresh-token=r1'))).toBe('/onboarding');
  });

  it('is issued the CSRF cookie its first write will need', async () => {
    const res = await visit('https://app.isaflow.co.za/accounting', REFRESH_ONLY);
    expect(res.headers.get('set-cookie') ?? '').toContain('isaflow_csrf=');
  });
});

describe('a browser holding neither cookie', () => {
  it.each([
    'https://app.isaflow.co.za/accounting',
    'https://app.isaflow.co.za/payroll/runs',
    'https://admin.isaflow.co.za/companies',
  ])('is still sent to /login from %s', async (url) => {
    expect(landsOn(await visit(url, 'ff_onboarding_done=1'))).toBe('/login');
  });

  it('an empty refresh cookie is not a session', async () => {
    expect(landsOn(await visit('https://app.isaflow.co.za/accounting', 'sb-refresh-token=; ff_onboarding_done=1'))).toBe('/login');
  });
});
