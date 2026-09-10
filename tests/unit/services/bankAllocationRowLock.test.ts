/**
 * bankAllocationService — the first read of the bank transaction must take a
 * row lock — plus the guarantees of the lock helper itself.
 *
 * allocateTransaction / splitAllocateTransaction / reverseReconciledTransaction
 * read `status`, refuse on the wrong one, and then post a journal. Without
 * `FOR UPDATE` two concurrent REQUESTS (UI double-click, agent retry with a
 * fresh idempotency key) both pass the status check and both post — one bank
 * transaction, two journals.
 *
 * These assert the SQL TEXT of the first `bank_transactions` read; the
 * companion DB-gated file (bankAllocationRowLockDb.test.ts) proves the lock
 * actually blocks a second session.
 */

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
import { enterFakeRequestCtx, runInRequestCtx } from '../helpers/requestCtx';
import {
  allocateTransaction,
  splitAllocateTransaction,
  reverseReconciledTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import {
  lockBankTransactionForUpdate,
  BankTransactionLockTimeoutError,
} from '@/modules/accounting/services/bank/bankTxLock';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const TX_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const ACCOUNT_ID = 'cccccccc-0000-0000-0000-cccccccccccc';
const USER_ID = 'dddddddd-0000-0000-0000-dddddddddddd';

/** Reconstruct the SQL text of a tagged-template call on the mocked `sql`. */
function sqlTextOf(callIdx: number): string {
  const call = vi.mocked(sql).mock.calls[callIdx];
  if (!call) throw new Error(`no sql call #${callIdx}`);
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  return strings
    .map((str, i) => str + (i < values.length ? (typeof values[i] === 'string' ? values[i] : '?') : ''))
    .join('');
}

describe('bankAllocationService — first bank_transactions read is locked', () => {
  beforeEach(() => {
    vi.mocked(sql).mockClear();
    // Empty result → each function throws its NOT_FOUND right after the read,
    // which is exactly the call we want to inspect.
    vi.mocked(sql).mockResolvedValue([] as unknown[]);
    enterFakeRequestCtx();
  });

  it('allocateTransaction reads FOR UPDATE, scoped to the company', async () => {
    await expect(
      allocateTransaction(COMPANY_ID, TX_ID, ACCOUNT_ID, USER_ID),
    ).rejects.toThrow(/not found/i);

    const text = sqlTextOf(0);
    expect(text).toMatch(/FROM bank_transactions/);
    expect(text).toMatch(/FOR UPDATE/);
    expect(text).toContain(COMPANY_ID);
    expect(text).toContain(TX_ID);
  });

  it('splitAllocateTransaction reads FOR UPDATE, scoped to the company', async () => {
    await expect(
      splitAllocateTransaction(COMPANY_ID, TX_ID, [{ contraAccountId: ACCOUNT_ID, amount: 100 }], USER_ID),
    ).rejects.toThrow(/not found/i);

    const text = sqlTextOf(0);
    expect(text).toMatch(/FROM bank_transactions/);
    expect(text).toMatch(/FOR UPDATE/);
    expect(text).toContain(COMPANY_ID);
    expect(text).toContain(TX_ID);
  });

  it('reverseReconciledTransaction reads FOR UPDATE, scoped to the company', async () => {
    await expect(
      reverseReconciledTransaction(COMPANY_ID, TX_ID, USER_ID),
    ).rejects.toThrow(/not found/i);

    const text = sqlTextOf(0);
    expect(text).toMatch(/FROM bank_transactions/);
    expect(text).toMatch(/FOR UPDATE/);
    expect(text).toContain(COMPANY_ID);
    expect(text).toContain(TX_ID);
  });
});

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
