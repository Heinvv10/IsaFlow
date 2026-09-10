/**
 * A 55P03 out of the match UPDATE has two readings and the mapping must ask
 * which one it is.
 *
 * `withBankLockBudget` sets `lock_timeout` for the whole UPDATE, so the code
 * fires on a row/index wait (a real race) AND on a relation-level wait
 * — DDL, `VACUUM FULL`, migration 657's own index build. Mapped to LINE_CLAIMED
 * unconditionally, a deploy told users their journal line was "already matched
 * to another bank transaction", which is a claim about a row nothing is known
 * about, and the auto-match run counted it as a race.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, lockMock, tableLockMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn(() => '') }),
  lockMock: vi.fn(),
  tableLockMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', async (importOriginal) => {
  // The REAL BankMatchUnavailableError and isLockNotAvailable: the mapping is
  // narrowed with `instanceof`, so a re-declared class would prove nothing.
  const actual = await importOriginal<
    typeof import('@/modules/accounting/services/bank/bankTxLock')
  >();
  return {
    ...actual,
    lockBankTransactionForUpdate: lockMock,
    tableLockUnavailable: tableLockMock,
    // Pass-through: the budget is a pg setting, measured by k144-match-line-lock-timeout.
    withBankLockBudget: (fn: () => Promise<unknown>) => fn(),
  };
});

import { matchTransaction, BankMatchTargetError } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { BankMatchUnavailableError } from '@/modules/accounting/services/bank/bankTxLock';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const TX = '22222222-2222-2222-2222-222222222222';
const LINE = '33333333-3333-3333-3333-333333333333';

class PgError extends Error {
  constructor(readonly code: string, readonly constraint?: string) { super(code); }
}

/** row lock ok → line exists → nobody claims it → the UPDATE fails with `err`. */
function updateFailsWith(err: unknown): void {
  lockMock.mockResolvedValue({ id: TX, status: 'imported' });
  sqlMock
    .mockResolvedValueOnce([{ id: LINE }] as never)   // assertMatchTargets: line exists
    .mockResolvedValueOnce([] as never)               // assertMatchTargets: unclaimed
    .mockRejectedValueOnce(err as never);             // the write
}

describe('matchTransaction — what a 55P03 on the write means', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlMock.mockReset();
    tableLockMock.mockReset();
  });

  it('calls it unavailable — not claimed — when the table itself is locked', async () => {
    updateFailsWith(new PgError('55P03'));
    tableLockMock.mockResolvedValue(true);

    const err = await matchTransaction(COMPANY, TX, LINE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BankMatchUnavailableError);
    expect((err as Error).message).not.toMatch(/already matched/i);
  });

  it('still calls it LINE_CLAIMED when the table is free', async () => {
    updateFailsWith(new PgError('55P03'));
    tableLockMock.mockResolvedValue(false);

    const err = await matchTransaction(COMPANY, TX, LINE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BankMatchTargetError);
    expect((err as BankMatchTargetError).code).toBe('LINE_CLAIMED');
  });

  // Adjacent case: the 23505 needs no probe — the index named the conflict.
  it('maps the unique violation without asking about the table', async () => {
    updateFailsWith(new PgError('23505', 'uq_bank_tx_matched_line'));

    const err = await matchTransaction(COMPANY, TX, LINE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BankMatchTargetError);
    expect((err as BankMatchTargetError).code).toBe('LINE_CLAIMED');
    expect(tableLockMock).not.toHaveBeenCalled();
  });

  // Adjacent case: any other failure is a real one and must reach the caller
  // unchanged — a 23505 on a DIFFERENT constraint is not this race.
  it('propagates an unrelated error untouched', async () => {
    updateFailsWith(new PgError('23505', 'some_other_unique'));

    const err = await matchTransaction(COMPANY, TX, LINE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PgError);
    expect(tableLockMock).not.toHaveBeenCalled();
  });
});
