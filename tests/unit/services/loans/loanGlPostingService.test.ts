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
  createJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn().mockResolvedValue('dddddddd-0000-0000-0000-000000000004'),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn().mockResolvedValue('bank-acc-0000-0000-0000-000000000099'),
}));

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import {
  buildPeriodJournalInput,
  postPeriodJournals,
  getLoanGlPostings,
  type LoanGlAccounts,
} from '@/modules/accounting/services/loans/loanGlPostingService';
import type { ScheduleRow } from '@/lib/amortisation/types';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const createEntryMock = createJournalEntry as unknown as ReturnType<typeof vi.fn>;
const postEntryMock = postJournalEntry as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN_ID     = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID     = 'dddddddd-0000-0000-0000-000000000004';
const ENTRY_ID    = 'eeeeeeee-0000-0000-0000-000000000005';

const ACCOUNTS: LoanGlAccounts = {
  loanLiability: 'loan-liab-0000-0000-0000-000000000010',
  interestExpense: 'int-exp-0000-0000-0000-000000000011',
  interestPayable: 'int-pay-0000-0000-0000-000000000012',
  bank: 'bank-acc-0000-0000-0000-000000000099',
  currentPortion: 'cur-port-0000-0000-0000-000000000013',
};

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    period: 1,
    date: '2026-04-15',
    opening: 224_873.49,
    rate: 14.25,
    installment: 4_663.84,
    interest: 2_670.37,
    principal: 1_993.47,
    intPortion: 2_670.37,
    skip: false,
    payment: 4_663.84,
    lump: 0,
    closing: 222_880.02,
    stLiability: 20_000,
    extrapolated: false,
    nca_flagged: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── buildPeriodJournalInput (pure function) ──────────────────────────────────

describe('buildPeriodJournalInput', () => {
  it('non-skip period with no lump: Dr Interest Expense + Dr Loan Liability, Cr Bank', () => {
    const row = makeRow();
    const input = buildPeriodJournalInput(row, ACCOUNTS, `Loan period 1`);
    expect(input.entryDate).toBe('2026-04-15');
    expect(input.lines).toHaveLength(3);

    const intExp = input.lines.find((l) => l.glAccountId === ACCOUNTS.interestExpense)!;
    expect(intExp.debit).toBeCloseTo(2_670.37, 2);
    expect(intExp.credit).toBe(0);

    const loanLiab = input.lines.find((l) => l.glAccountId === ACCOUNTS.loanLiability)!;
    expect(loanLiab.debit).toBeCloseTo(1_993.47, 2);
    expect(loanLiab.credit).toBe(0);

    const bank = input.lines.find((l) => l.glAccountId === ACCOUNTS.bank)!;
    expect(bank.credit).toBeCloseTo(4_663.84, 2);
    expect(bank.debit).toBe(0);
  });

  it('skip period: Dr Interest Expense, Cr Interest Payable (no bank leg)', () => {
    const row = makeRow({ skip: true, payment: 0, interest: 2_646.70, principal: 0, closing: 225_526.72 });
    const input = buildPeriodJournalInput(row, ACCOUNTS, 'Loan skip');
    expect(input.lines).toHaveLength(2);
    expect(input.lines.some((l) => l.glAccountId === ACCOUNTS.bank)).toBe(false);
    const exp = input.lines.find((l) => l.glAccountId === ACCOUNTS.interestExpense)!;
    expect(exp.debit).toBeCloseTo(2_646.70, 2);
    const pay = input.lines.find((l) => l.glAccountId === ACCOUNTS.interestPayable)!;
    expect(pay.credit).toBeCloseTo(2_646.70, 2);
  });

  it('lump period: adds Dr Loan Liability (lump) / Cr Bank (lump) legs', () => {
    const row = makeRow({
      interest: 2_678.13, principal: 2_084.20, payment: 4_762.33, lump: 125_000, closing: 98_442.52,
    });
    const input = buildPeriodJournalInput(row, ACCOUNTS, 'Loan lump');
    // Expect combined bank leg = payment + lump = 129_762.33
    const bank = input.lines.find((l) => l.glAccountId === ACCOUNTS.bank)!;
    expect(bank.credit).toBeCloseTo(129_762.33, 2);
    // Loan liability total debit = principal + lump
    const loanTotal = input.lines
      .filter((l) => l.glAccountId === ACCOUNTS.loanLiability)
      .reduce((s, l) => s + l.debit, 0);
    expect(loanTotal).toBeCloseTo(2_084.20 + 125_000, 2);
  });

  it('journal is balanced: Σ debits = Σ credits', () => {
    const row = makeRow();
    const input = buildPeriodJournalInput(row, ACCOUNTS, 'Balanced');
    const dr = input.lines.reduce((s, l) => s + l.debit, 0);
    const cr = input.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it('balanced even in skip period', () => {
    const row = makeRow({ skip: true, payment: 0, principal: 0, interest: 1_000 });
    const input = buildPeriodJournalInput(row, ACCOUNTS, 'Skip balanced');
    const dr = input.lines.reduce((s, l) => s + l.debit, 0);
    const cr = input.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it('balanced with lump', () => {
    const row = makeRow({ lump: 75_000, interest: 1_169, principal: 929.15, payment: 2_098.15, closing: 22_513.37 });
    const input = buildPeriodJournalInput(row, ACCOUNTS, 'Lump balanced');
    const dr = input.lines.reduce((s, l) => s + l.debit, 0);
    const cr = input.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it('balanced when payment is less than interest (tiny-remainder case)', () => {
    // Last period with small balance, interest > payment (clearing to residual)
    const row = makeRow({
      opening: 100, interest: 50, principal: -30, payment: 20, closing: 130,
    });
    const input = buildPeriodJournalInput(row, ACCOUNTS, 'payment<interest');
    const dr = input.lines.reduce((s, l) => s + l.debit, 0);
    const cr = input.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it('omits interest expense line when interest is zero (already fully capped)', () => {
    const row = makeRow({ interest: 0, principal: 4_663.84, payment: 4_663.84 });
    const input = buildPeriodJournalInput(row, ACCOUNTS, 'No interest');
    expect(input.lines.some((l) => l.glAccountId === ACCOUNTS.interestExpense)).toBe(false);
    const dr = input.lines.reduce((s, l) => s + l.debit, 0);
    const cr = input.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBeCloseTo(cr, 2);
  });
});

// ── postPeriodJournals ──────────────────────────────────────────────────────

/**
 * `lockLoanForUpdate` refuses to run outside a request transaction (review L3):
 * an unbounded `FOR UPDATE` on a pooled connection can be neither timed out nor
 * rolled back. The stub client only has to absorb the `SET LOCAL lock_timeout`
 * statements — every read goes through the mocked `sql`.
 */
function inRequestTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  return als.run(
    { client, userId: USER_ID, companyId: COMPANY_ID, claims: {} } as never,
    fn,
  );
}

describe('postPeriodJournals', () => {
  function makeLoanRow(overrides = {}) {
    return {
      id: LOAN_ID,
      company_id: COMPANY_ID,
      gl_account_id: ACCOUNTS.loanLiability,
      interest_expense_account_id: ACCOUNTS.interestExpense,
      interest_payable_account_id: ACCOUNTS.interestPayable,
      bank_account_id: ACCOUNTS.bank,
      current_portion_account_id: ACCOUNTS.currentPortion,
      start_date: '2026-03-15',
      ...overrides,
    };
  }

  function makeScheduleDbRow(period: number, overrides = {}) {
    return {
      run_id: 'run-0000-0000-0000-0000-000000000021',
      period,
      date: '2026-04-15',
      opening: '224873.49',
      rate: '14.250000',
      installment: '4663.84',
      interest: '2670.37',
      principal: '1993.47',
      lump: '0',
      skip_flag: false,
      payment: '4663.84',
      closing: '222880.02',
      st_liability: '20000',
      extrapolated: false,
      nca_flagged: false,
      ...overrides,
    };
  }

  it('creates, posts, and records GL posting for a single non-skip period', async () => {
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])             // loan lookup
      .mockResolvedValueOnce([{ id: 'run-id-21' }])       // latest schedule run
      .mockResolvedValueOnce([makeScheduleDbRow(1)])      // schedule row for period
      .mockResolvedValueOnce([])                            // period lock check (not locked)
      .mockResolvedValueOnce([])                            // already-posted check (none)
      .mockResolvedValueOnce([{ id: 'posting-1' }]);       // insert loan_gl_posting

    createEntryMock.mockResolvedValueOnce({ id: ENTRY_ID, entryNumber: 'JE-2026-001', fiscalPeriodId: 'fp-2026-04' });
    postEntryMock.mockResolvedValueOnce({ id: ENTRY_ID, status: 'posted' });

    const result = await inRequestTx(() => postPeriodJournals(COMPANY_ID, LOAN_ID, 1, USER_ID));
    expect(result.journalEntryId).toBe(ENTRY_ID);
    expect(result.period).toBe(1);
    expect(createEntryMock).toHaveBeenCalledTimes(1);
    expect(postEntryMock).toHaveBeenCalledTimes(1);
  });

  it('throws when loan not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(inRequestTx(() => postPeriodJournals(COMPANY_ID, LOAN_ID, 1, USER_ID))).rejects.toThrow('not found');
  });

  it('throws when loan missing required GL accounts', async () => {
    sqlMock.mockResolvedValueOnce([
      makeLoanRow({ interest_expense_account_id: null }),
    ]);
    await expect(inRequestTx(() => postPeriodJournals(COMPANY_ID, LOAN_ID, 1, USER_ID))).rejects.toThrow('account');
  });

  it('throws when period is locked', async () => {
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])
      .mockResolvedValueOnce([{ id: 'run-id-21' }])
      .mockResolvedValueOnce([makeScheduleDbRow(1)])
      .mockResolvedValueOnce([{ yyyymm: '202604', locked_at: '2026-04-30T00:00:00Z' }]);

    await expect(inRequestTx(() => postPeriodJournals(COMPANY_ID, LOAN_ID, 1, USER_ID))).rejects.toThrow('locked');
  });

  it('throws when the schedule row is NCA-flagged (in-duplum breach)', async () => {
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])
      .mockResolvedValueOnce([{ id: 'run-id-21' }])
      .mockResolvedValueOnce([makeScheduleDbRow(1, { nca_flagged: true })]);
    await expect(inRequestTx(() => postPeriodJournals(COMPANY_ID, LOAN_ID, 1, USER_ID))).rejects.toThrow('NCA');
  });
});

// ── getLoanGlPostings ──────────────────────────────────────────────────────

describe('getLoanGlPostings', () => {
  it('returns mapped postings for a loan', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'posting-1',
      company_id: COMPANY_ID,
      loan_id: LOAN_ID,
      period: 1,
      posting_date: '2026-04-15',
      account_id: ACCOUNTS.loanLiability,
      debit: '1993.47',
      credit: '0',
      narrative: 'Loan period 1 – principal payment',
      posted_period: '202604',
      reversal_of: null,
      journal_entry_id: ENTRY_ID,
      created_at: '2026-04-15T00:00:00Z',
    }]);
    const postings = await getLoanGlPostings(COMPANY_ID, LOAN_ID);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      loanId: LOAN_ID,
      period: 1,
      debit: 1_993.47,
      credit: 0,
      journalEntryId: ENTRY_ID,
    });
  });

  it('returns empty array when no postings', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const postings = await getLoanGlPostings(COMPANY_ID, LOAN_ID);
    expect(postings).toEqual([]);
  });
});
