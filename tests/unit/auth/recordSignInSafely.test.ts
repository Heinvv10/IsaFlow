/**
 * recordSignInSafely is called with `void` on the sign-in path: whatever goes wrong with the stamp (database error,
 * statement timeout, no connection) is logged and swallowed, a failed stamp is rolled back and its connection
 * handed back, and the stamp is bounded by a statement_timeout it sets itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/signInStampPool', () => ({ signInStampPool: () => ({ connect }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));

import { recordSignInSafely, SIGN_IN_STAMP_TIMEOUT_MS } from '@/lib/auth/recordSignIn';

function clientAnswering(stamp: () => unknown) {
  const calls: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (text: string) => {
      calls.push(text);
      if (/^WITH due/.test(text)) return stamp();
      return { rowCount: 0 };
    }),
    release,
  };
  connect.mockResolvedValueOnce(client);
  return { calls, release };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('recordSignInSafely', () => {
  it('stamps in one transaction that sets its own statement_timeout, and logs nothing', async () => {
    const { calls, release } = clientAnswering(() => ({ rowCount: 1 }));
    await recordSignInSafely('user-1', 'login');
    expect(calls.map((c) => c.split(/\s/)[0])).toEqual(['BEGIN', 'SET', 'WITH', 'COMMIT']);
    // The literal in recordSignIn.ts and the exported constant must stay one number.
    expect(calls[1]).toBe(`SET LOCAL statement_timeout = ${SIGN_IN_STAMP_TIMEOUT_MS}`);
    expect(release).toHaveBeenCalledWith(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failing statement is rolled back, logged with the user and path, and does not throw', async () => {
    const { calls, release } = clientAnswering(() => { throw new Error('canceling statement due to statement timeout'); });
    await expect(recordSignInSafely('user-1', 'login')).resolves.toBeUndefined();
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalledWith('sign-in not recorded',
      { userId: 'user-1', via: 'login', message: 'canceling statement due to statement timeout' }, 'Auth');
  });

  it('no connection to be had is logged and swallowed', async () => {
    connect.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    await expect(recordSignInSafely('user-1', '2fa-challenge')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
