/**
 * The reversal claim's two guards, neither of which the integration tests reach.
 *
 * `claimJournalReversal` refuses outright without an open transaction: outside
 * one the UPDATE autocommits and the claim can outlive the contra it stands
 * for, which is worse than the race it closes. And a claim that waits out its
 * 5s `lock_timeout` must reach the caller as a retry instruction, not as a raw
 * 55P03 reported as a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
}));
vi.mock('@/lib/alsTransaction', () => ({ withAlsTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import {
  claimJournalReversal,
  JournalReversalLockTimeoutError,
} from '@/modules/accounting/services/gl/journalEntryReversalClaim';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** A client that answers the two settings statements and nothing else. */
function fakeClient(): PoolClient {
  return {
    query: vi.fn(async () => ({ rows: [{ v: '0' }] })),
  } as unknown as PoolClient;
}

function withCtx<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: USER_ID, companyId: COMPANY_ID, claims: {} }, fn);
}

beforeEach(() => { sqlMock.mockReset(); });

describe('claimJournalReversal', () => {
  it('refuses to run without an open transaction', async () => {
    await expect(claimJournalReversal(COMPANY_ID, ENTRY_ID, USER_ID))
      .rejects.toThrow(/requires an open transaction/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('maps a lock_timeout to a retryable error naming the entry', async () => {
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
    const client = fakeClient();

    const err = await withCtx(client, () => claimJournalReversal(COMPANY_ID, ENTRY_ID, USER_ID))
      .then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(JournalReversalLockTimeoutError);
    expect(err!.message).toContain(ENTRY_ID);
    expect(err!.message).toMatch(/retry/i);
  });

  it('restores the lock_timeout it borrowed, even when the claim throws', async () => {
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '55P03' }));
    const client = fakeClient();

    await withCtx(client, () => claimJournalReversal(COMPANY_ID, ENTRY_ID, USER_ID)).catch(() => undefined);

    const calls = (client.query as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const restore = calls.find((c) => Array.isArray(c[1]));
    expect(restore, 'the claim must set lock_timeout back to what it found').toBeDefined();
    expect(String(restore![0])).toContain('set_config');
    expect(restore![1]).toEqual(['0']);
  });

  it('reports the winner and the loser from the rows the predicated UPDATE returns', async () => {
    const client = fakeClient();
    sqlMock.mockResolvedValueOnce([{ id: ENTRY_ID }]);
    await expect(withCtx(client, () => claimJournalReversal(COMPANY_ID, ENTRY_ID, USER_ID))).resolves.toBe(true);

    sqlMock.mockResolvedValueOnce([]);
    await expect(withCtx(client, () => claimJournalReversal(COMPANY_ID, ENTRY_ID, USER_ID))).resolves.toBe(false);

    // The predicate is what makes the loser lose; assert it is actually issued.
    expect(String(sqlMock.mock.calls[0]![0])).toContain('reversed_at IS NULL');
  });
});
