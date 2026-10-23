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

// S-07c (migration 930): every statement runs on the migration_admin pool.
const { adminQueryMock } = vi.hoisted(() => ({ adminQueryMock: vi.fn() }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminPool: () => ({ query: adminQueryMock }),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  issuePasswordResetToken,
  supersedePasswordResetTokens,
  withdrawPasswordResetToken,
  consumePasswordResetToken,
} from '@/lib/auth/passwordResetService';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Positional params of admin-pool call N. */
function callValues(callIndex: number): unknown[] {
  return adminQueryMock.mock.calls[callIndex]![1] as unknown[];
}
function callText(callIndex: number): string {
  return String(adminQueryMock.mock.calls[callIndex]![0]);
}
function rowsOnce(rows: unknown[]): void {
  adminQueryMock.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

beforeEach(() => {
  adminQueryMock.mockReset();
  adminQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('issuePasswordResetToken', () => {
  it('returns a high-entropy token, its hash and a future expiry', async () => {
    const { token, tokenHash, expiresAt } = await issuePasswordResetToken(USER_ID);
    expect(token).toMatch(/^[a-f0-9]{64}$/); // 32 bytes hex
    expect(tokenHash).toBe(sha256(token));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('persists only the sha256 hash of the token, never the raw token', async () => {
    const { token } = await issuePasswordResetToken(USER_ID);
    const allValues = adminQueryMock.mock.calls.flatMap((_, i) => callValues(i));
    expect(allValues).not.toContain(token); // raw token never hits the DB
    expect(allValues).toContain(sha256(token)); // hash is the INSERT'd token_hash
  });

  it('only inserts — prior links stay live until the new one is delivered (R-032)', async () => {
    await issuePasswordResetToken(USER_ID);
    expect(adminQueryMock).toHaveBeenCalledTimes(1);
    expect(callText(0)).toMatch(/INSERT INTO auth_password_reset_tokens/);
  });
});

describe('supersedePasswordResetTokens / withdrawPasswordResetToken', () => {
  it('retires only the user\'s tokens issued before the delivered one (ordering proven in r-032-reset-supersede-order)', async () => {
    await supersedePasswordResetTokens(USER_ID, 'keep-hash');
    const text = callText(0);
    expect(text).toMatch(/SET consumed_at = now\(\)/);
    expect(text).toMatch(/\(t\.created_at, t\.id\) < \(k\.created_at, k\.id\)/);
    expect(callValues(0)).toEqual(['keep-hash', USER_ID]);
  });

  it('withdraws exactly the one token that was never sent', async () => {
    await withdrawPasswordResetToken('unsent-hash');
    const text = callText(0);
    expect(text).toMatch(/WHERE token_hash = \$1 AND consumed_at IS NULL/);
    expect(callValues(0)).toEqual(['unsent-hash']);
  });
});

describe('consumePasswordResetToken', () => {
  it('resolves the user for a valid token and marks it consumed atomically', async () => {
    rowsOnce([{ id: 'tok-1', user_id: USER_ID }]); // SELECT
    rowsOnce([{ id: 'tok-1' }]); // UPDATE ... RETURNING
    const result = await consumePasswordResetToken('rawtoken');
    expect(result).toEqual({ userId: USER_ID });
    // Looked up by hash, not by the raw token.
    expect(callValues(0)).toContain(sha256('rawtoken'));
  });

  it('returns null for an unknown or expired token', async () => {
    rowsOnce([]); // SELECT finds nothing
    expect(await consumePasswordResetToken('nope')).toBeNull();
  });

  it('returns null when the token was already consumed in a race (UPDATE affects 0 rows)', async () => {
    rowsOnce([{ id: 'tok-1', user_id: USER_ID }]); // SELECT
    rowsOnce([]); // UPDATE affected nothing — lost the race
    expect(await consumePasswordResetToken('rawtoken')).toBeNull();
  });
});
