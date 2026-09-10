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
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'entry-reclass-0001', entryNumber: 'JE-R-001', fiscalPeriodId: 'fp-2026-04' }),
  resolveUserUuid: vi.fn().mockResolvedValue('user-uuid'),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: vi.fn().mockResolvedValue({ id: 'entry-reclass-0001', status: 'posted' }),
}));

import { als } from '@/lib/als';
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

/**
 * Round-4 M1. `closeLoanPeriod` now refuses to run outside a request
 * transaction: `pg_advisory_xact_lock` taken on a pooled connection is
 * released the instant it is taken, so the guard would serialise nothing. The
 * stub client absorbs nothing here — every read goes through the mocked `sql`.
 */
function inRequestTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  return als.run({ client, userId: USER_ID, companyId: COMPANY_ID, claims: {} } as never, fn);
}

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
    sqlMock
      .mockResolvedValueOnce([])                              // advisory lock on the company's closes
      .mockResolvedValueOnce([])                              // no later period closed
      .mockResolvedValueOnce([{ yyyymm: '202604' }]);         // already locked
    await expect(inRequestTx(() => closeLoanPeriod(COMPANY_ID, '202604', USER_ID)))
      .rejects.toThrow('already locked');
  });

  it('processes each active loan: posts reclass, then locks period', async () => {
    sqlMock
      .mockResolvedValueOnce([])                                // 1. advisory lock on the company's closes
      .mockResolvedValueOnce([])                                // 1b. no later period closed
      .mockResolvedValueOnce([])                                // 1c. isPeriodLocked
      .mockResolvedValueOnce([{                                  // 2. JOINed loans + snapshot
        ...makeLoanRow(),
        snapshot_closing: '200000',
        snapshot_stliability: '48000',
        snapshot_date: '2026-04-30',
      }])
      .mockResolvedValueOnce([{                                  // 3. lock insert
        company_id: COMPANY_ID, yyyymm: '202604',
        locked_at: '2026-04-30T00:00:00Z', locked_by: USER_ID,
      }]);

    const result = await inRequestTx(() => closeLoanPeriod(COMPANY_ID, '202604', USER_ID));
    expect(result.yyyymm).toBe('202604');
    expect(result.loansProcessed).toBe(1);
    expect(result.reclassEntries).toHaveLength(1);
    expect(result.locked).toBe(true);
  });

  it('completes even when no active loans exist', async () => {
    sqlMock
      .mockResolvedValueOnce([])                               // advisory lock on the company's closes
      .mockResolvedValueOnce([])                               // no later period closed
      .mockResolvedValueOnce([])                               // isPeriodLocked
      .mockResolvedValueOnce([])                               // no active loans (JOINed query)
      .mockResolvedValueOnce([{                                 // lock insert
        company_id: COMPANY_ID,
        yyyymm: '202604',
        locked_at: '2026-04-30T00:00:00Z',
        locked_by: USER_ID,
      }]);
    const result = await inRequestTx(() => closeLoanPeriod(COMPANY_ID, '202604', USER_ID));
    expect(result.loansProcessed).toBe(0);
    expect(result.locked).toBe(true);
  });

  it('fetches loans + period rows in a single query (no N+1)', async () => {
    const loansPlusRows = [
      {
        ...makeLoanRow(),
        snapshot_closing: '200000', snapshot_stliability: '48000', snapshot_date: '2026-04-30',
      },
      {
        ...makeLoanRow({ id: 'bbbbbbbb-0000-0000-0000-000000000003', reference: 'BND-002' }),
        snapshot_closing: '100000', snapshot_stliability: '20000', snapshot_date: '2026-04-30',
      },
    ];
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (q.includes('FROM loans l')) return Promise.resolve(loansPlusRows);
      if (q.includes('INSERT INTO loan_period_locks')) {
        return Promise.resolve([{ yyyymm: '202604', locked_at: 't' }]);
      }
      return Promise.resolve([]);
    });

    await inRequestTx(() => closeLoanPeriod(COMPANY_ID, '202604', USER_ID));

    // Previously this was 1 loans query + N period-row queries. The loans and
    // their period rows must still come back in ONE query, and nothing may
    // re-read loan_schedule_rows per loan. Counting total calls instead would
    // break every time a bounded per-posting write is added, which is why this
    // asserts the shape rather than a magic number.
    const queries = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(queries.filter((q) => q.includes('FROM loans l'))).toHaveLength(1);
    expect(
      queries.filter((q) => q.includes('loan_schedule_rows') && !q.includes('FROM loans l')),
    ).toHaveLength(0);
  });

  it('posts reclass journal with correct Dr/Cr amounts', async () => {
    const { createJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryCrudService');
    const createMock = createJournalEntry as unknown as ReturnType<typeof vi.fn>;
    sqlMock
      .mockResolvedValueOnce([])                                 // advisory lock on the company's closes
      .mockResolvedValueOnce([])                                 // no later period closed
      .mockResolvedValueOnce([])                                 // isPeriodLocked
      .mockResolvedValueOnce([{
        ...makeLoanRow(),
        snapshot_closing: '200000', snapshot_stliability: '48000', snapshot_date: '2026-04-30',
      }])
      .mockResolvedValueOnce([{ yyyymm: '202604', locked_at: 't' }]);

    await inRequestTx(() => closeLoanPeriod(COMPANY_ID, '202604', USER_ID));

    expect(createMock).toHaveBeenCalledTimes(1);
    const input = createMock.mock.calls[0]![1];
    const liabLine = input.lines.find((l: { glAccountId: string }) => l.glAccountId === ACCOUNTS.loanLiability)!;
    const currentLine = input.lines.find((l: { glAccountId: string }) => l.glAccountId === ACCOUNTS.currentPortion)!;
    expect(liabLine.debit).toBeCloseTo(48_000, 2);
    expect(currentLine.credit).toBeCloseTo(48_000, 2);
  });

  it('skips loans missing required GL accounts and records them in result', async () => {
    sqlMock
      .mockResolvedValueOnce([])                                 // advisory lock on the company's closes
      .mockResolvedValueOnce([])                                 // no later period closed
      .mockResolvedValueOnce([])                                 // isPeriodLocked
      .mockResolvedValueOnce([{                                  // loan with NULL gl_account_id
        ...makeLoanRow({ gl_account_id: null }),
        snapshot_closing: '100000', snapshot_stliability: '20000', snapshot_date: '2026-04-30',
      }])
      .mockResolvedValueOnce([{ yyyymm: '202604', locked_at: 't' }]);

    const result = await inRequestTx(() => closeLoanPeriod(COMPANY_ID, '202604', USER_ID));
    expect(result.skippedLoans).toHaveLength(1);
    expect(result.skippedLoans![0]).toMatchObject({ loanId: LOAN_ID, reason: 'missing GL accounts' });
  });
});
