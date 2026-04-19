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

import { sql } from '@/lib/neon';
import {
  checkNcaCompliance,
  determineEclStage,
  computeEclAmount,
  computeDaysPastDue,
  computeNpvImpact,
  assessLoan,
  listAssessments,
} from '@/modules/accounting/services/loans/loanComplianceService';
import type { ScheduleRow, LoanInputs, RatePoint } from '@/lib/amortisation/types';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID    = 'dddddddd-0000-0000-0000-000000000004';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    period: 1, date: '2026-04-15',
    opening: 100_000, rate: 14.25,
    installment: 4_663.84, interest: 2_670.37, principal: 1_993.47,
    intPortion: 2_670.37, skip: false, payment: 4_663.84, lump: 0,
    closing: 98_000, stLiability: 20_000, extrapolated: false,
    nca_flagged: false, ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

// ── checkNcaCompliance (pure) ───────────────────────────────────────────────

describe('checkNcaCompliance', () => {
  it('returns compliant when no rows are flagged', () => {
    const result = checkNcaCompliance([makeRow(), makeRow({ period: 2 })]);
    expect(result.flagged).toBe(false);
    expect(result.firstBreachPeriod).toBeNull();
  });

  it('returns breached when a row is nca_flagged', () => {
    const result = checkNcaCompliance([
      makeRow(),
      makeRow({ period: 8, nca_flagged: true }),
      makeRow({ period: 9, nca_flagged: true }),
    ]);
    expect(result.flagged).toBe(true);
    expect(result.firstBreachPeriod).toBe(8);
    expect(result.breachCount).toBe(2);
  });

  it('returns not flagged on empty schedule', () => {
    const result = checkNcaCompliance([]);
    expect(result.flagged).toBe(false);
  });
});

// ── determineEclStage (pure) ────────────────────────────────────────────────

describe('determineEclStage', () => {
  it('returns stage 1 when 0-30 days past due', () => {
    expect(determineEclStage(0)).toBe(1);
    expect(determineEclStage(15)).toBe(1);
    expect(determineEclStage(30)).toBe(1);
  });

  it('returns stage 2 when 31-90 days past due', () => {
    expect(determineEclStage(31)).toBe(2);
    expect(determineEclStage(60)).toBe(2);
    expect(determineEclStage(90)).toBe(2);
  });

  it('returns stage 3 when more than 90 days past due', () => {
    expect(determineEclStage(91)).toBe(3);
    expect(determineEclStage(365)).toBe(3);
  });

  it('returns stage 1 for negative (pre-paid) DPD', () => {
    expect(determineEclStage(-5)).toBe(1);
  });
});

// ── computeEclAmount (pure) ─────────────────────────────────────────────────

describe('computeEclAmount', () => {
  const schedule = [
    makeRow({ period: 1, interest: 1_000, closing: 99_000 }),
    makeRow({ period: 2, interest: 990, closing: 98_000 }),
    makeRow({ period: 3, interest: 980, closing: 97_000 }),
  ];

  it('stage 1 — 12-month ECL: PD * LGD * next-12-month exposure, small percentage', () => {
    const result = computeEclAmount(1, 100_000, schedule);
    expect(result.method).toBe('12m');
    expect(result.amount).toBeGreaterThan(0);
    expect(result.amount).toBeLessThan(5_000);  // well below 5% of outstanding
  });

  it('stage 2 — lifetime ECL: higher than stage 1 for same exposure', () => {
    const stage1 = computeEclAmount(1, 100_000, schedule);
    const stage2 = computeEclAmount(2, 100_000, schedule);
    expect(stage2.method).toBe('lifetime');
    expect(stage2.amount).toBeGreaterThan(stage1.amount);
  });

  it('stage 3 — full exposure impaired (100% of outstanding)', () => {
    const result = computeEclAmount(3, 100_000, schedule);
    expect(result.method).toBe('full');
    expect(result.amount).toBeCloseTo(100_000, 2);
  });

  it('returns zero ECL when outstanding is zero', () => {
    const result = computeEclAmount(3, 0, schedule);
    expect(result.amount).toBe(0);
  });
});

// ── computeDaysPastDue (pure) ──────────────────────────────────────────────

describe('computeDaysPastDue', () => {
  it('returns 0 when last payment is on or before scheduled date', () => {
    // (lastPayment, asOf, scheduled) — paid on schedule → 0 DPD
    expect(computeDaysPastDue('2026-04-15', '2026-04-15', '2026-04-15')).toBe(0);
    expect(computeDaysPastDue('2026-04-10', '2026-04-15', '2026-04-15')).toBe(0);
  });

  it('returns positive DPD when payment arrives after scheduled date', () => {
    expect(computeDaysPastDue('2026-04-25', '2026-04-25', '2026-04-15')).toBe(10);
  });

  it('handles nulls gracefully — no last payment means asOf - scheduled', () => {
    expect(computeDaysPastDue(null, '2026-04-25', '2026-04-15')).toBe(10);
  });

  it('returns 0 when no scheduled date', () => {
    expect(computeDaysPastDue('2026-04-15', '2026-04-25', null)).toBe(0);
  });
});

// ── computeNpvImpact (pure) ─────────────────────────────────────────────────

describe('computeNpvImpact', () => {
  const baseLoan: LoanInputs = {
    id: 'orig', principal: 200_000, startDate: '2026-03-15', termMonths: 60,
    rateMode: 'FIXED', margin: 0, fixedRate: 12, residual: 0,
    recurringSkipMonths: [], dayCount: 'ACTUAL_365',
    repriceMode: 'FIXED_INSTALLMENT', skipMode: 'MAINTAIN_TERM', lumpMode: 'REDUCE_INSTALLMENT',
  };
  const curve: RatePoint[] = [{ effectiveDate: '2026-01-01', rate: 10 }];

  it('returns 0% delta when modification is identical', () => {
    const result = computeNpvImpact(baseLoan, baseLoan, curve);
    expect(Math.abs(result.deltaPct)).toBeLessThan(0.001);
  });

  it('returns positive delta when new terms lower effective rate significantly', () => {
    const softer: LoanInputs = { ...baseLoan, fixedRate: 6 };
    const result = computeNpvImpact(baseLoan, softer, curve);
    // Lower rate → lower NPV of payments → delta > 0 in absolute terms
    expect(Math.abs(result.deltaPct)).toBeGreaterThan(0);
  });

  it('flags substantial modification when delta exceeds 10%', () => {
    const restructured: LoanInputs = { ...baseLoan, termMonths: 120, fixedRate: 5 };
    const result = computeNpvImpact(baseLoan, restructured, curve);
    expect(result.substantial).toBe(result.deltaPct > 10);
  });
});

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
