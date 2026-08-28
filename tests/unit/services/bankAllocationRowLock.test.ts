/**
 * bankAllocationService — the first read of the bank transaction must take a
 * row lock.
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
import {
  allocateTransaction,
  splitAllocateTransaction,
  reverseReconciledTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';

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
