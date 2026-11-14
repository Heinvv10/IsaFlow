/**
 * recordSignInSafely sits on the sign-in path: whatever goes wrong with the stamp (database error, pool exhausted,
 * hung connection) is logged and swallowed, and the sign-in is never held up longer than the timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/migrationAdminPool', () => ({ migrationAdminPool: () => ({ query }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));

import { recordSignInSafely, RECORD_SIGN_IN_TIMEOUT_MS } from '@/lib/auth/recordSignIn';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('recordSignInSafely', () => {
  it('a rejected statement is logged with the user and path, and does not throw', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));
    await expect(recordSignInSafely('user-1', 'login')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('sign-in not recorded', { userId: 'user-1', via: 'login', message: 'connection refused' }, 'Auth');
  });

  it('a hung statement releases the sign-in after the timeout', async () => {
    vi.useFakeTimers();
    query.mockReturnValueOnce(new Promise(() => undefined));
    const done = recordSignInSafely('user-1', '2fa-challenge');
    await vi.advanceTimersByTimeAsync(RECORD_SIGN_IN_TIMEOUT_MS + 1);
    await expect(done).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1]?.message)).toMatch(/timed out/);
  });

  it('a stamped sign-in logs nothing', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await recordSignInSafely('user-1', 'login');
    expect(warn).not.toHaveBeenCalled();
  });
});
