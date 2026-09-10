/**
 * K-107 round 6, LOW-4 and LOW-5 — the two edges of `claimUnderLockTimeout`.
 *
 * LOW-4: `SET LOCAL lock_timeout = DEFAULT` ran on the success path only. A
 * 55P03 must skip it (the transaction is aborted and the restore would raise
 * 25P02, replacing the typed error), but ANY OTHER failure leaves the
 * transaction usable and left the 5s ceiling set for every later statement in
 * the request — the exact leak `reserveNextDocumentNumber` was fixed for.
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

  it('sets the 5s ceiling and restores it after a successful claim', async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const out = await als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => 'claimed'));
    expect.soft(out).toBe('claimed');
    expect(query.mock.calls.map((c) => c[0])).toEqual([
      "SET LOCAL lock_timeout = '5s'", 'SET LOCAL lock_timeout = DEFAULT',
    ]);
  });

  it('restores the ceiling when the claim fails as a JS throw, on a still-usable transaction', async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const boom = new Error('nothing to claim');
    await expect(als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => { throw boom; })))
      .rejects.toBe(boom);
    expect(query.mock.calls.map((c) => c[0])).toContain('SET LOCAL lock_timeout = DEFAULT');
  });

  it('reports the constraint that fired, not the 25P02 the restore raises on the aborted tx', async () => {
    // r9 LOW-1. A SQL failure out of the claim ABORTS the transaction, so the
    // recovery `SET LOCAL … DEFAULT` rejects with 25P02 on a REAL connection —
    // which the previous version of this test could not produce, because it
    // mocked a client that never rejects. Unguarded, that rejection replaces
    // the 23505 and the operator loses the cause.
    const aborted = Object.assign(
      new Error('current transaction is aborted, commands ignored until end of transaction block'),
      { code: '25P02' },
    );
    const query = vi.fn().mockImplementation((text: string) =>
      (text === 'SET LOCAL lock_timeout = DEFAULT' ? Promise.reject(aborted) : Promise.resolve(undefined)));
    const boom = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const err = await als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => { throw boom; }))
      .then(() => null, (e: unknown) => e);
    expect.soft(err).toBe(boom);
    expect.soft((err as { code?: string } | null)?.code).toBe('23505');
    // The restore was still ATTEMPTED — it is what a JS throw needs.
    expect(query.mock.calls.map((c) => c[0])).toEqual([
      "SET LOCAL lock_timeout = '5s'", 'SET LOCAL lock_timeout = DEFAULT',
    ]);
  });

  it('does NOT touch the aborted transaction after a 55P03, and types the error', async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const timeout = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const err = await als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => { throw timeout; }))
      .then(() => null, (e: unknown) => e);
    expect.soft(err).toBeInstanceOf(DocumentClaimLockTimeoutError);
    expect(query.mock.calls.map((c) => c[0])).toEqual(["SET LOCAL lock_timeout = '5s'"]);
  });
});
