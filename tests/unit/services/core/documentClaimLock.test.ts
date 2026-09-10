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

  it('restores the ceiling when the claim fails for a reason OTHER than the lock timeout', async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const boom = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(als.run(ctxWith(query), () => claimUnderLockTimeout('quote', async () => { throw boom; })))
      .rejects.toBe(boom);
    expect(query.mock.calls.map((c) => c[0])).toContain('SET LOCAL lock_timeout = DEFAULT');
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
