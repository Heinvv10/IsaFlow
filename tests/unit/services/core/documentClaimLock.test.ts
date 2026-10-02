/**
 * K-107 round 6, LOW-4 and LOW-5 — the two edges of `claimUnderLockTimeout`.
 *
 * D8 round 10: the restore puts back the value the claim FOUND (it used to reset to DEFAULT, which unbounded an
 * enclosing core/rowLockBudget budget), from a `finally`.
 *
 * LOW-4: the restore ran on the success path only. ANY failure that leaves the
 * transaction usable left the 5s ceiling set for every later statement in the
 * request — the exact leak `reserveNextDocumentNumber` was fixed for. D8 round 11:
 * the restore is always attempted; on an aborted transaction (55P03, 23505) its
 * 25P02 must not replace the real error.
 *
 * LOW-5: outside a request transaction the claim autocommits and cannot be
 * rolled back with the posting that follows it, so it refuses rather than
 * claiming anyway — the same choice `lockTimeEntries` makes.
 */
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import {
  ClaimOutsideTransactionError,
  DocumentClaimLockTimeoutError,
  claimUnderLockTimeout,
} from '@/modules/accounting/services/core/documentClaimLock';

function ctxWith(query: ReturnType<typeof vi.fn>) {
  return { client: { query }, userId: 'u', companyId: 'c', claims: {} } as unknown as Parameters<typeof als.run>[0];
}

describe('claimUnderLockTimeout', () => {
  it('refuses to claim outside a request transaction', async () => {
    await expect(claimUnderLockTimeout('quote', async () => 'claimed'))
      .rejects.toBeInstanceOf(ClaimOutsideTransactionError);
  });

  it('sets the 5s ceiling and restores the value it found after a successful claim', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ v: '17s' }] });
    const out = await als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => 'claimed'));
    expect.soft(out).toBe('claimed');
    expect(query.mock.calls.map((c) => c[0])).toEqual([
      "SELECT current_setting('lock_timeout') AS v", "SET LOCAL lock_timeout = '5s'",
      "SELECT set_config('lock_timeout', $1, true)",
    ]);
    expect(query.mock.calls[2]![1]).toEqual(['17s']);
  });

  it('restores the ceiling when the claim fails as a JS throw, on a still-usable transaction', async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const boom = new Error('nothing to claim');
    await expect(als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => { throw boom; })))
      .rejects.toBe(boom);
    expect(query.mock.calls.map((c) => c[0])).toContain("SELECT set_config('lock_timeout', $1, true)");
  });

  it('reports the constraint that fired, not the 25P02 a restore would raise on the aborted tx', async () => {
    // r9 LOW-1. A SQL failure out of the claim ABORTS the transaction, so a
    // restore statement rejects with 25P02 on a REAL connection. Unguarded, that
    // rejection replaces the 23505 and the operator loses the cause. D8 round 11:
    // the restore is attempted and its 25P02 swallowed (the rollback restores it).
    const aborted = Object.assign(
      new Error('current transaction is aborted, commands ignored until end of transaction block'),
      { code: '25P02' },
    );
    const query = vi.fn().mockImplementation((text: string) =>
      (text.startsWith('SELECT set_config') ? Promise.reject(aborted) : Promise.resolve(undefined)));
    const boom = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const err = await als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => { throw boom; }))
      .then(() => null, (e: unknown) => e);
    expect.soft(err).toBe(boom);
    expect.soft((err as { code?: string } | null)?.code).toBe('23505');
    expect(query.mock.calls.map((c) => c[0])).toEqual([
      "SELECT current_setting('lock_timeout') AS v", "SET LOCAL lock_timeout = '5s'",
      "SELECT set_config('lock_timeout', $1, true)",
    ]);
  });

  it('types a 55P03, and the restore\'s 25P02 on the aborted transaction does not replace it', async () => {
    const aborted = Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    const query = vi.fn().mockImplementation((text: string) =>
      (text.startsWith('SELECT set_config') ? Promise.reject(aborted) : Promise.resolve(undefined)));
    const timeout = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const err = await als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => { throw timeout; }))
      .then(() => null, (e: unknown) => e);
    expect.soft(err).toBeInstanceOf(DocumentClaimLockTimeoutError);
    expect(query.mock.calls.map((c) => c[0])).toEqual([
      "SELECT current_setting('lock_timeout') AS v", "SET LOCAL lock_timeout = '5s'",
      "SELECT set_config('lock_timeout', $1, true)",
    ]);
  });
});
