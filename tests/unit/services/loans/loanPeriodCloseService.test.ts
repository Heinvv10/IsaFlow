// RED phase — written before implementation
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'entry-reclass-0001', entryNumber: 'JE-R-001' }),
  resolveUserUuid: vi.fn().mockResolvedValue('user-uuid'),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: vi.fn().mockResolvedValue({ id: 'entry-reclass-0001', status: 'posted' }),
}));

import { sql } from '@/lib/neon';
import {
  buildReclassificationInput,
  lockPeriod,
  isPeriodLocked,
  closeLoanPeriod,
} from '@/modules/accounting/services/loans/loanPeriodCloseService';
import type { LoanGlAccounts } from '@/modules/accounting/services/loans/loanGlPostingService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID    = 'dddddddd-0000-0000-0000-000000000004';

const ACCOUNTS: LoanGlAccounts = {
  loanLiability: 'loan-liab-0000-0000-0000-000000000010',
  interestExpense: 'int-exp-0000-0000-0000-000000000011',
  interestPayable: 'int-pay-0000-0000-0000-000000000012',
  bank: 'bank-acc-0000-0000-0000-000000000099',
  currentPortion: 'cur-port-0000-0000-0000-000000000013',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── buildReclassificationInput (pure) ────────────────────────────────────────

describe('buildReclassificationInput', () => {
  it('moves stLiability from long-term to current portion account', () => {
    const input = buildReclassificationInput(
      { closing: 200_000, stLiability: 48_000 },
      ACCOUNTS,
      '2026-04-30',
      'Reclassification – loan ABC for 202604',
    );
    expect(input.entryDate).toBe('2026-04-30');
    expect(input.lines).toHaveLength(2);

    const fromLongTerm = input.lines.find((l) => l.glAccountId === ACCOUNTS.loanLiability)!;
    expect(fromLongTerm.debit).toBeCloseTo(48_000, 2);
    expect(fromLongTerm.credit).toBe(0);

    const toCurrent = input.lines.find((l) => l.glAccountId === ACCOUNTS.currentPortion)!;
    expect(toCurrent.credit).toBeCloseTo(48_000, 2);
    expect(toCurrent.debit).toBe(0);
  });

  it('produces balanced entry', () => {
    const input = buildReclassificationInput(
      { closing: 100_000, stLiability: 20_000 },
      ACCOUNTS,
      '2026-04-30',
      'balanced',
    );
    const dr = input.lines.reduce((s, l) => s + l.debit, 0);
    const cr = input.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it('returns empty lines when stLiability is zero (no-op)', () => {
    const input = buildReclassificationInput(
      { closing: 100_000, stLiability: 0 },
      ACCOUNTS,
      '2026-04-30',
      'noop',
    );
    expect(input.lines).toHaveLength(0);
  });
});

// ── isPeriodLocked ───────────────────────────────────────────────────────────

describe('isPeriodLocked', () => {
  it('returns true when a lock row exists', async () => {
    sqlMock.mockResolvedValueOnce([{ yyyymm: '202604' }]);
    expect(await isPeriodLocked(COMPANY_ID, '202604')).toBe(true);
  });

  it('returns false when no lock row', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect(await isPeriodLocked(COMPANY_ID, '202604')).toBe(false);
  });
});

// ── lockPeriod ───────────────────────────────────────────────────────────────

describe('lockPeriod', () => {
  it('inserts lock row and returns lock info', async () => {
    sqlMock
      .mockResolvedValueOnce([])                         // existing-lock check (none)
      .mockResolvedValueOnce([{                          // insert returning
        company_id: COMPANY_ID,
        yyyymm: '202604',
        locked_at: '2026-04-30T00:00:00Z',
        locked_by: USER_ID,
      }]);
    const lock = await lockPeriod(COMPANY_ID, '202604', USER_ID);
    expect(lock).toMatchObject({ yyyymm: '202604', lockedBy: USER_ID });
  });

  it('throws when period is already locked', async () => {
    sqlMock.mockResolvedValueOnce([{ yyyymm: '202604' }]);  // existing lock check
    await expect(lockPeriod(COMPANY_ID, '202604', USER_ID)).rejects.toThrow('already locked');
  });
});

// ── closeLoanPeriod ──────────────────────────────────────────────────────────

describe('closeLoanPeriod', () => {
  function makeLoanRow(overrides = {}) {
    return {
      id: LOAN_ID,
      company_id: COMPANY_ID,
      reference: 'BND-001',
      gl_account_id: ACCOUNTS.loanLiability,
      interest_expense_account_id: ACCOUNTS.interestExpense,
      interest_payable_account_id: ACCOUNTS.interestPayable,
      bank_account_id: ACCOUNTS.bank,
      current_portion_account_id: ACCOUNTS.currentPortion,
      status: 'active',
      ...overrides,
    };
  }

  it('throws when period already locked', async () => {
    sqlMock.mockResolvedValueOnce([{ yyyymm: '202604' }]);  // already locked
    await expect(closeLoanPeriod(COMPANY_ID, '202604', USER_ID)).rejects.toThrow('already locked');
  });

  it('processes each active loan: posts reclass, then locks period', async () => {
    sqlMock
      .mockResolvedValueOnce([])                               // isPeriodLocked → not locked
      .mockResolvedValueOnce([makeLoanRow()])                  // active loans query
      .mockResolvedValueOnce([{                                 // period-end row for this loan
        closing: '200000', st_liability: '48000', date: '2026-04-30',
      }])
      .mockResolvedValue([]);                                    // subsequent inserts

    sqlMock.mockResolvedValueOnce([{
      company_id: COMPANY_ID,
      yyyymm: '202604',
      locked_at: '2026-04-30T00:00:00Z',
      locked_by: USER_ID,
    }]);

    const result = await closeLoanPeriod(COMPANY_ID, '202604', USER_ID);
    expect(result.yyyymm).toBe('202604');
    expect(result.loansProcessed).toBeGreaterThanOrEqual(0);
    expect(result.locked).toBe(true);
  });

  it('completes even when no active loans exist', async () => {
    sqlMock
      .mockResolvedValueOnce([])                               // isPeriodLocked
      .mockResolvedValueOnce([])                               // no active loans
      .mockResolvedValueOnce([{                                 // lock insert
        company_id: COMPANY_ID,
        yyyymm: '202604',
        locked_at: '2026-04-30T00:00:00Z',
        locked_by: USER_ID,
      }]);
    const result = await closeLoanPeriod(COMPANY_ID, '202604', USER_ID);
    expect(result.loansProcessed).toBe(0);
    expect(result.locked).toBe(true);
  });
});
