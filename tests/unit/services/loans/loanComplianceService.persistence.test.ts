// Split out of loanComplianceService.test.ts, which keeps the pure functions:
// everything here goes through the mocked `sql` client.
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

import { sql } from '@/lib/neon';
import {
  assessLoan,
  listAssessments,
} from '@/modules/accounting/services/loans/loanComplianceService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID    = 'dddddddd-0000-0000-0000-000000000004';

beforeEach(() => vi.clearAllMocks());

// ── assessLoan ──────────────────────────────────────────────────────────────

describe('assessLoan', () => {
  function makeLoanRow(overrides = {}) {
    return {
      id: LOAN_ID, company_id: COMPANY_ID,
      principal: '100000.00', start_date: '2026-03-15', term_months: 12,
      rate_mode: 'FIXED', margin: '0', fixed_rate: '12', residual: '0',
      recurring_skip_months: [], day_count: 'ACTUAL_365',
      reprice_mode: 'FIXED_INSTALLMENT', skip_mode: 'MAINTAIN_TERM', lump_mode: 'REDUCE_INSTALLMENT',
      curve_id: null, status: 'active', ncaCompliant: true,
      ...overrides,
    };
  }

  function makeScheduleDbRow(period: number, overrides = {}) {
    return {
      period, date: '2026-04-15', opening: '100000', rate: '12',
      installment: '8884.87', interest: '1000', principal: '7884.87',
      lump: '0', skip_flag: false, payment: '8884.87',
      closing: '92115.13', st_liability: '50000',
      extrapolated: false, nca_flagged: false, ...overrides,
    };
  }

  it('persists assessment with stage, ECL, and NCA info', async () => {
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])                               // loan
      .mockResolvedValueOnce([{ id: 'run-1' }])                              // latest run
      .mockResolvedValueOnce([                                               // schedule rows
        makeScheduleDbRow(1), makeScheduleDbRow(2), makeScheduleDbRow(3),
      ])
      .mockResolvedValueOnce([{ last_payment_date: '2026-04-15' }])          // last payment
      .mockResolvedValueOnce([{                                              // insert assessment
        id: 'assess-1', company_id: COMPANY_ID, loan_id: LOAN_ID,
        assessment_date: '2026-04-19', nca_flagged: false, nca_period: null,
        ifrs9_stage: 1, days_past_due: 0, ecl_amount: '150.50',
        ecl_method: '12m', outstanding: '92115.13', notes: null,
        assessed_by: USER_ID, assessed_at: '2026-04-19T00:00:00Z',
      }]);

    const result = await assessLoan(COMPANY_ID, LOAN_ID, USER_ID, '2026-04-19');
    expect(result).toMatchObject({
      loanId: LOAN_ID, stage: 1, ncaFlagged: false,
      daysPastDue: 0, eclMethod: '12m',
    });
  });

  it('throws when loan does not exist', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(assessLoan(COMPANY_ID, LOAN_ID, USER_ID, '2026-04-19')).rejects.toThrow('not found');
  });

  it('throws when no schedule run exists', async () => {
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])
      .mockResolvedValueOnce([]);  // no run
    await expect(assessLoan(COMPANY_ID, LOAN_ID, USER_ID, '2026-04-19')).rejects.toThrow('schedule');
  });
});

// ── listAssessments ────────────────────────────────────────────────────────

describe('listAssessments', () => {
  it('returns mapped assessments', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'assess-1', company_id: COMPANY_ID, loan_id: LOAN_ID,
      assessment_date: '2026-04-19', nca_flagged: false, nca_period: null,
      ifrs9_stage: 1, days_past_due: '0', ecl_amount: '150.50',
      ecl_method: '12m', outstanding: '92115.13', notes: null,
      assessed_by: USER_ID, assessed_at: '2026-04-19T00:00:00Z',
    }]);
    const results = await listAssessments(COMPANY_ID, LOAN_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ stage: 1, eclAmount: 150.50 });
  });

  it('returns empty array when none exist', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const results = await listAssessments(COMPANY_ID, LOAN_ID);
    expect(results).toEqual([]);
  });
});
