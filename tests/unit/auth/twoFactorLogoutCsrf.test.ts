/**
 * Pentest M8 — CSRF on 2FA mutation routes + logout.
 *
 * Each route is now wrapped with withCsrf (double-submit cookie). A POST without
 * a matching isaflow_csrf cookie + x-csrf-token header must be rejected with 403
 * BEFORE the handler runs. With a matching token the CSRF gate passes (the
 * request then fails auth/clears cookies, but NOT with a 403).
 *
 * gotrue modules are mocked so importing the routes never touches the network;
 * in the cases under test the handler's own cookie-auth returns before any
 * gotrue call anyway.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth/gotrue', () => ({
  verifyToken: vi.fn(async () => ({ sub: 'u1', email: 'u@x.com' })),
  logout: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  enrollTotp: vi.fn(async () => ({})),
  challengeFactor: vi.fn(async () => ({})),
  verifyFactor: vi.fn(async () => ({})),
  unenrollFactor: vi.fn(async () => ({})),
  GotrueMfaError: class extends Error {},
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import enroll from '../../../pages/api/auth/2fa-enroll';
import confirm from '../../../pages/api/auth/2fa-confirm';
import disable from '../../../pages/api/auth/2fa-disable';
import logout from '../../../pages/api/auth/logout';

const TOKEN = 'a'.repeat(64); // ≥32 chars, equal length for both sides

interface FakeRes { statusCode: number; body: unknown; status: (c: number) => FakeRes; json: (b: unknown) => FakeRes; setHeader: () => void; getHeader: () => undefined; end: () => FakeRes; }
function makeRes(): FakeRes {
  const res = { statusCode: 200, body: undefined } as FakeRes;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  res.getHeader = () => undefined;
  res.end = () => res;
  return res;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReq(opts: { csrf?: boolean }): any {
  return {
    method: 'POST',
    body: {},
    cookies: opts.csrf ? { isaflow_csrf: TOKEN } : {},
    headers: opts.csrf ? { 'x-csrf-token': TOKEN } : {},
  };
}

const routes: Array<[string, (req: unknown, res: unknown) => unknown]> = [
  ['2fa-enroll', enroll as never],
  ['2fa-confirm', confirm as never],
  ['2fa-disable', disable as never],
  ['logout', logout as never],
];

describe('M8 — CSRF protection on 2FA routes + logout', () => {
  for (const [name, handler] of routes) {
    it(`${name}: POST without a CSRF token → 403`, async () => {
      const res = makeRes();
      await handler(makeReq({ csrf: false }), res);
      expect(res.statusCode).toBe(403);
    });

    it(`${name}: POST with a matching CSRF token passes the CSRF gate (not 403)`, async () => {
      const res = makeRes();
      await handler(makeReq({ csrf: true }), res);
      expect(res.statusCode).not.toBe(403);
    });
  }
});
