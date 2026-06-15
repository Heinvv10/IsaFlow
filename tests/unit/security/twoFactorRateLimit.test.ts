/**
 * Pentest re-run H7 — 2FA confirm/disable had no app-level rate limit.
 *
 * Both endpoints verify a 6-digit TOTP code against a factor_id with only withCsrf,
 * relying entirely on GoTrue's internal limits. A session holder could brute-force the
 * code to reach AAL2 or disable 2FA. Both now apply a per-factor checkRateLimit (5/15min),
 * mirroring 2fa-challenge. These tests assert a 429 (and no GoTrue verify) when over.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/withCsrf', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withCsrf: (h: any) => h,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/cookies', () => ({
  parseCookies: vi.fn().mockReturnValue({ sb_access: 'tok' }),
  setAuthCookies: vi.fn(),
  ACCESS_COOKIE: 'sb_access',
}));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  challengeFactor: vi.fn(), verifyFactor: vi.fn(), unenrollFactor: vi.fn(),
  GotrueMfaError: class GotrueMfaError extends Error {},
}));

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: checkRateLimitMock,
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));

import { challengeFactor, verifyFactor, unenrollFactor } from '@/lib/auth/gotrue-mfa';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import confirmHandler from '../../../pages/api/auth/2fa-confirm';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import disableHandler from '../../../pages/api/auth/2fa-disable';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: any) => Promise<unknown>;

function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}
function makeReq() {
  return { method: 'POST', headers: {}, body: { factor_id: 'f1', code: '000000' } };
}

const CASES: Array<[string, Handler, string]> = [
  ['2fa-confirm', confirmHandler as Handler, '2fa:confirm:f1'],
  ['2fa-disable', disableHandler as Handler, '2fa:disable:f1'],
];

describe('2FA endpoints H7 — per-factor brute-force rate limit', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(CASES)('%s returns 429 and skips GoTrue verify when over the limit', async (_name, handler, expectedKey) => {
    checkRateLimitMock.mockResolvedValue(false);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(checkRateLimitMock).toHaveBeenCalledWith(expectedKey, { max: 5, windowSecs: 900 });
    expect(res.status).toHaveBeenCalledWith(429);
    expect(challengeFactor).not.toHaveBeenCalled();
  });

  it.each(CASES)('%s proceeds to GoTrue verify when under the limit', async (_name, handler) => {
    checkRateLimitMock.mockResolvedValue(true);
    (challengeFactor as ReturnType<typeof vi.fn>).mockResolvedValue('challenge-1');
    (verifyFactor as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
    });
    (unenrollFactor as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(challengeFactor).toHaveBeenCalledTimes(1);
  });
});
