/**
 * Join and Sign Out on /invite/<token> are CSRF-checked (withCsrf), and the
 * isaflow_csrf cookie used to be issued only by protected pages. A browser
 * that signs in from an invitation (/login?invite=...&returnTo=/invite/<t>)
 * never loads one, so every Join answered 403 "CSRF token mismatch" (PR #908
 * architecture review). The invitation page and the login page issue it.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '../../middleware';

const csrfSetBy = async (url: string, cookie?: string): Promise<boolean> => {
  const headers: Record<string, string> = { host: new URL(url).host };
  if (cookie) headers.cookie = cookie;
  const res = await middleware(new NextRequest(url, { headers }));
  return (res.headers.get('set-cookie') ?? '').includes('isaflow_csrf=');
};

describe('the CSRF cookie on the invitation path', () => {
  it('is issued on /invite/<token> to a fresh browser', async () => {
    expect(await csrfSetBy(`https://app.isaflow.co.za/invite/${'ab'.repeat(32)}`)).toBe(true);
  });

  it('is issued on /login (the sign-in route out of an invitation)', async () => {
    expect(await csrfSetBy('https://app.isaflow.co.za/login?invite=x&returnTo=%2Finvite%2Fx')).toBe(true);
  });

  it('an existing cookie is left alone', async () => {
    expect(await csrfSetBy(`https://app.isaflow.co.za/invite/${'ab'.repeat(32)}`, `isaflow_csrf=${'c'.repeat(32)}`)).toBe(false);
  });

  it('other public API paths are unchanged', async () => {
    expect(await csrfSetBy('https://app.isaflow.co.za/api/invite/x')).toBe(false);
  });
});
