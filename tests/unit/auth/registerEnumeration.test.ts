/**
 * Pentest A1-6 — register user-enumeration + per-email throttle.
 *
 * - An already-registered email must be rejected with a GENERIC message BEFORE
 *   any company is created (no second-company bug, no definitive "email taken").
 * - A per-email throttle returns 429 independent of the per-IP limit.
 * - A brand-new email still proceeds to account creation.
 *
 * gotrue + rateLimit + cookies + logger are mocked; the handler returns before
 * any pg work in the cases under test, so pg need not be mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { checkRateLimitMock, getUserMock, createUserMock, signInMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  getUserMock: vi.fn(),
  createUserMock: vi.fn(),
  signInMock: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: <T>(h: T) => h, // pass-through (per-IP limit not under test here)
  checkRateLimit: checkRateLimitMock,
  getClientIp: () => '1.2.3.4',
}));
vi.mock('@/lib/auth/gotrue', () => ({
  adminCreateUser: createUserMock,
  adminGetUserByEmail: getUserMock,
  signIn: signInMock,
}));
vi.mock('@/lib/auth/cookies', () => ({ setAuthCookies: vi.fn(), setActiveCompanyCookie: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import handler from '../../../pages/api/auth/register';

interface FakeRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => FakeRes;
  json: (b: unknown) => FakeRes;
  setHeader: (k: string, v: string) => void;
}
function makeRes(): FakeRes {
  const res = { statusCode: 200, body: undefined } as FakeRes;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => {};
  return res;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReq(body: Record<string, unknown>): any {
  return { method: 'POST', body, headers: {}, socket: {} };
}
const VALID = { email: 'x@example.com', password: 'longenough10', companyName: 'Acme' };

beforeEach(() => {
  checkRateLimitMock.mockReset();
  getUserMock.mockReset();
  createUserMock.mockReset();
  signInMock.mockReset();
});

describe('register — A1-6 enumeration + throttle', () => {
  it('returns 429 when the per-email throttle is exceeded (before any lookup)', async () => {
    checkRateLimitMock.mockResolvedValue(false);
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(makeReq(VALID), res);
    expect(res.statusCode).toBe(429);
    expect(getUserMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('rejects an already-registered email with a generic 400, before creating anything', async () => {
    checkRateLimitMock.mockResolvedValue(true);
    getUserMock.mockResolvedValue({ id: 'existing-user' });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(makeReq({ ...VALID, email: 'taken@example.com' }), res);
    expect(res.statusCode).toBe(400);
    // generic — must NOT definitively confirm the email exists
    const text = JSON.stringify(res.body).toLowerCase();
    expect(text).not.toMatch(/already registered|email.*taken|in use|email exists|duplicate/);
    // and must NOT have proceeded to create a GoTrue user / company
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('lets a brand-new email proceed to account creation', async () => {
    checkRateLimitMock.mockResolvedValue(true);
    getUserMock.mockRejectedValue(new Error('user not found')); // lookup miss → new email
    createUserMock.mockRejectedValue(new Error('SENTINEL_CREATE_REACHED'));
    const res = makeRes();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handler as any)(makeReq({ ...VALID, email: 'new@example.com' }), res)
    ).rejects.toThrow('SENTINEL_CREATE_REACHED');
    expect(createUserMock).toHaveBeenCalledTimes(1);
  });
});
