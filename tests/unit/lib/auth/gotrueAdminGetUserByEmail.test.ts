/**
 * Unit tests for adminGetUserByEmail (src/lib/auth/gotrue.ts).
 *
 * Regression: the lookup used `filter=email.eq.<x>`, which GoTrue's admin API
 * treats as a literal ILIKE search string (not a PostgREST expression), so it
 * matched zero users — every forgot-password lookup threw "no user" and no
 * reset email was sent. It must query by the plain email and then EXACT-match
 * client-side (the ILIKE can return substring near-matches like
 * user@example.com.attacker.test — returning that would be an account-takeover).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { adminGetUserByEmail } from '@/lib/auth/gotrue';

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.GOTRUE_URL = 'http://gotrue.test/auth/v1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function gotrueReturns(users: Array<{ id: string; email: string }>) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ users }) });
}

describe('adminGetUserByEmail', () => {
  it('queries with a plain email filter, not the broken email.eq. expression', async () => {
    gotrueReturns([{ id: 'u1', email: 'user@example.com' }]);
    await adminGetUserByEmail('user@example.com');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('filter=' + encodeURIComponent('user@example.com'));
    expect(url).not.toContain('email.eq.');
  });

  it('exact-matches (case-insensitive) and ignores substring near-matches', async () => {
    gotrueReturns([
      { id: 'attacker', email: 'user@example.com.attacker.test' },
      { id: 'real', email: 'User@Example.com' },
    ]);
    const user = await adminGetUserByEmail('user@example.com');
    expect(user.id).toBe('real');
  });

  it('throws when no exact match exists (only near-matches returned)', async () => {
    gotrueReturns([{ id: 'x', email: 'user@example.com.evil.test' }]);
    await expect(adminGetUserByEmail('user@example.com')).rejects.toThrow('no gotrue user');
  });
});
