/**
 * Unit tests for passwordResetService.ts
 *
 * Self-owned single-use password reset tokens. Security-critical invariants:
 *  - the raw token is never persisted (only sha256(token))
 *  - a token is single-use (atomic consume)
 *  - expired / unknown / already-consumed tokens never resolve a user
 *  - create invalidates prior tokens and inserts in one transaction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    // withTransaction invokes its callback with the same mock so we can inspect
    // the statements issued inside the transaction.
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  createPasswordResetToken,
  consumePasswordResetToken,
} from '@/lib/auth/passwordResetService';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Interpolated values (not the template-strings array) of a tagged sql call. */
function callValues(callIndex: number): unknown[] {
  return sqlMock.mock.calls[callIndex]!.slice(1);
}

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

describe('createPasswordResetToken', () => {
  it('returns a high-entropy token and a future expiry', async () => {
    const { token, expiresAt } = await createPasswordResetToken(USER_ID);
    expect(token).toMatch(/^[a-f0-9]{64}$/); // 32 bytes hex
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('persists only the sha256 hash of the token, never the raw token', async () => {
    const { token } = await createPasswordResetToken(USER_ID);
    const allValues = sqlMock.mock.calls.flatMap((_, i) => callValues(i));
    expect(allValues).not.toContain(token); // raw token never hits the DB
    expect(allValues).toContain(sha256(token)); // hash is the INSERT'd token_hash
  });

  it('invalidates prior unconsumed tokens then inserts (two statements in a tx)', async () => {
    await createPasswordResetToken(USER_ID);
    expect(sqlMock).toHaveBeenCalledTimes(2); // UPDATE (invalidate) + INSERT
  });
});

describe('consumePasswordResetToken', () => {
  it('resolves the user for a valid token and marks it consumed atomically', async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: 'tok-1', user_id: USER_ID }]) // SELECT
      .mockResolvedValueOnce([{ id: 'tok-1' }]); // UPDATE ... RETURNING
    const result = await consumePasswordResetToken('rawtoken');
    expect(result).toEqual({ userId: USER_ID });
    // Looked up by hash, not by the raw token.
    expect(callValues(0)).toContain(sha256('rawtoken'));
  });

  it('returns null for an unknown or expired token', async () => {
    sqlMock.mockResolvedValueOnce([]); // SELECT finds nothing
    expect(await consumePasswordResetToken('nope')).toBeNull();
  });

  it('returns null when the token was already consumed in a race (UPDATE affects 0 rows)', async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: 'tok-1', user_id: USER_ID }]) // SELECT
      .mockResolvedValueOnce([]); // UPDATE affected nothing — lost the race
    expect(await consumePasswordResetToken('rawtoken')).toBeNull();
  });
});
