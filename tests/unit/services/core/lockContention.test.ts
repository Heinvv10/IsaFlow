/**
 * Contention, not fault: `55P03` and `40P01` are one answer to a caller.
 *
 * A lock timeout was already mapped to a typed, retryable refusal on every
 * settlement lock. A DEADLOCK was not — it reached `withAuth` as a bare pg
 * error and was answered 500, on the money path, to a user whose only mistake
 * was arriving at the same instant as somebody else. The canonical lock order
 * in `bank/.claude.md` is what makes a deadlock unlikely; this is what stops
 * the one that still happens from being reported as a server fault.
 *
 * Both SQLSTATEs abort the transaction, so nothing either request wrote
 * survives and retrying unchanged is the correct remedy in both cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    queries: [] as string[],
    client: { query: (t: string) => { mockTx.queries.push(t); return Promise.resolve(undefined); } },
  },
}));
vi.mock('@/lib/als', async () => {
  const actual = await vi.importActual<typeof import('@/lib/als')>('@/lib/als');
  return { ...actual, als: { ...actual.als, getStore: () => ({ client: mockTx.client }) } };
});
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));

import { isLockContention } from '@/modules/accounting/services/core/lockContention';
import {
  lockBankTransactionForUpdate,
  isBankTransactionLockTimeout,
} from '@/modules/accounting/services/bank/bankTxLock';
import {
  lockCustomerPaymentForUpdate,
  lockSupplierPaymentForUpdate,
} from '@/modules/accounting/services/core/paymentLock';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ROW = '22222222-2222-4222-8222-222222222222';

const pgError = (code: string) =>
  Object.assign(new Error(`pg said ${code}`), { code });

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
  mockTx.queries.length = 0;
});

describe('isLockContention', () => {
  it('accepts both contention SQLSTATEs', () => {
    expect(isLockContention(pgError('55P03'))).toBe(true);   // lock_not_available
    expect(isLockContention(pgError('40P01'))).toBe(true);   // deadlock_detected
  });

  // The predicate is the message-disclosure boundary's neighbour: it decides
  // which failures get a hand-written retry message instead of the generic
  // fault answer. Anything it lets through wrongly is a fault reported as the
  // user's problem, so the negatives matter as much as the positives.
  it('rejects every other failure, including the neighbouring SQLSTATEs', () => {
    for (const code of ['40001', '25P02', '23505', '42703', '55P04', '', '40p01']) {
      expect(isLockContention(pgError(code)), code).toBe(false);
    }
    expect(isLockContention(new Error('no code at all'))).toBe(false);
    expect(isLockContention({ code: 40101 })).toBe(false);   // non-string code
    expect(isLockContention('40P01')).toBe(false);           // not an object
    expect(isLockContention(null)).toBe(false);
    expect(isLockContention(undefined)).toBe(false);
  });
});

describe('lockBankTransactionForUpdate', () => {
  it('answers a DEADLOCK with the retryable typed error, not a raw pg throw', async () => {
    sqlMock.mockRejectedValueOnce(pgError('40P01'));
    const err = await lockBankTransactionForUpdate(COMPANY, ROW).catch((e: unknown) => e);

    // Structural, the way the route tests it — `isBankTransactionLockTimeout`
    // is what `bank-match-confirm` answers 409 on.
    expect(isBankTransactionLockTimeout(err)).toBe(true);
    expect((err as Error).message).toMatch(/retry in a moment/i);
  });

  it('still lets a genuine fault through untouched', async () => {
    sqlMock.mockRejectedValueOnce(pgError('25P02'));
    const err = await lockBankTransactionForUpdate(COMPANY, ROW).catch((e: unknown) => e);
    expect(isBankTransactionLockTimeout(err)).toBe(false);
    expect((err as { code: string }).code).toBe('25P02');
  });
});

describe('the payment locks', () => {
  it('answer a DEADLOCK with the retryable refusal on both arms', async () => {
    for (const lock of [lockCustomerPaymentForUpdate, lockSupplierPaymentForUpdate]) {
      sqlMock.mockRejectedValueOnce(pgError('40P01'));
      const err = await lock(COMPANY, ROW).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('PAYMENT_LOCK_TIMEOUT');
      expect((err as Error).message).toMatch(/retry in a moment/i);
      // NOT restored after contention: the transaction is aborted and the reset
      // would itself raise 25P02, replacing the typed error with an opaque one.
      expect(mockTx.queries).not.toContain('SET LOCAL lock_timeout = DEFAULT');
    }
  });
});
