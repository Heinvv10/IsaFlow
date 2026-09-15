/** Focused lock-helper contracts. Actual account/split/inverse contention is proved in bank39LockBatch.int.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  return {
    sql: vi.fn(async () => [] as unknown[]),
    fmtDate: actual.fmtDate,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(vi.fn())),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { runInRequestCtx } from '../helpers/requestCtx';
import {
  lockBankTransactionForUpdate,
  BankTransactionLockTimeoutError,
} from '@/modules/accounting/services/bank/bankTxLock';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const TX_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

describe('lockBankTransactionForUpdate — helper guarantees', () => {
  beforeEach(() => {
    vi.mocked(sql).mockClear();
    vi.mocked(sql).mockResolvedValue([] as unknown[]);
  });

  it('refuses to run outside a request transaction', async () => {
    // Outside withAuth's BEGIN…COMMIT every statement is its own implicit
    // transaction, so FOR UPDATE would be released the instant the SELECT
    // returned — a lock that silently locks nothing.
    await expect(
      als.run(undefined as never, () => lockBankTransactionForUpdate(COMPANY_ID, TX_ID)),
    ).rejects.toThrow(/requires a request transaction/);
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('bounds the wait with SET LOCAL lock_timeout on the request client', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    await runInRequestCtx(() => lockBankTransactionForUpdate(COMPANY_ID, TX_ID), client);

    expect(client.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5s'");
  });

  // `SET LOCAL` lasts to the end of the TRANSACTION, not the statement, and both
  // confirm arms and `voidPaymentDocument` now call this helper FIRST — so
  // without the restore the 5s budget silently governs every lock they take
  // afterwards. Every sibling lock (`paymentLock`, `creditNoteLock`,
  // `supplierInvoiceLock`, the two allocation-line fetchers) restores it and is
  // pinned in both directions; this one was not.
  it('restores lock_timeout to DEFAULT once the lock is taken', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    await runInRequestCtx(() => lockBankTransactionForUpdate(COMPANY_ID, TX_ID), client);

    expect(client.query).toHaveBeenCalledWith('SET LOCAL lock_timeout = DEFAULT');
  });

  // The other direction, and the reason the restore is NOT in a `finally`:
  // after a lock timeout the transaction is aborted, so the restore would
  // itself raise 25P02 and replace the typed error with an opaque one.
  it('does not attempt the restore after a lock timeout', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    vi.mocked(sql).mockRejectedValueOnce(
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }) as never,
    );

    await expect(
      runInRequestCtx(() => lockBankTransactionForUpdate(COMPANY_ID, TX_ID), client),
    ).rejects.toBeInstanceOf(BankTransactionLockTimeoutError);
    expect(client.query).not.toHaveBeenCalledWith('SET LOCAL lock_timeout = DEFAULT');
  });

  it('turns a 55P03 lock timeout into a readable, retryable error', async () => {
    const lockErr = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    vi.mocked(sql).mockRejectedValueOnce(lockErr as never);

    const attempt = runInRequestCtx(() => lockBankTransactionForUpdate(COMPANY_ID, TX_ID));
    await expect(attempt).rejects.toBeInstanceOf(BankTransactionLockTimeoutError);
    await expect(attempt).rejects.toThrow(/retry in a moment/);
  });

  it('leaves any other database error alone', async () => {
    vi.mocked(sql).mockRejectedValueOnce(
      Object.assign(new Error('column does not exist'), { code: '42703' }) as never,
    );

    await expect(
      runInRequestCtx(() => lockBankTransactionForUpdate(COMPANY_ID, TX_ID)),
    ).rejects.toThrow('column does not exist');
  });
});
