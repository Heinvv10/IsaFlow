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
  getOrComputeSchedule,
  previewSchedule,
  getPortfolioSummary,
} from '@/modules/accounting/services/loans/loanScheduleService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const CURVE_ID   = 'cccccccc-0000-0000-0000-000000000003';
const RUN_ID     = 'dddddddd-0000-0000-0000-000000000004';

function makeLoanRow(overrides = {}) {
  return {
    id: LOAN_ID,
    company_id: COMPANY_ID,
    curve_id: CURVE_ID,
    counterparty_id: null,
    gl_account_id: null,
    reference: 'BND-001',
    product: 'bond',
    description: null,
    principal: '224873.49',
    start_date: '2026-03-15',
    term_months: 72,
    rate_mode: 'PRIME_PLUS',
    margin: '4.0000',
    fixed_rate: null,
    residual: '0.00',
    day_count: 'ACTUAL_365',
    reprice_mode: 'RESOLVE_ON_RATE_CHANGE',
    skip_mode: 'MAINTAIN_TERM',
    lump_mode: 'REDUCE_INSTALLMENT',
    recurring_skip_months: [12, 1],
    status: 'active',
    nca_compliant: true,
    currency: 'ZAR',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeRunRow() {
  return {
    id: RUN_ID,
    loan_id: LOAN_ID,
    company_id: COMPANY_ID,
    computed_at: '2026-04-19T00:00:00Z',
    engine_version: '1.0.0',
    inputs_hash: 'abc123',
  };
}

function makeScheduleRowDb(period: number, overrides = {}) {
  return {
    run_id: RUN_ID,
    period,
    date: `2026-0${period + 3}-15`,
    opening: '224873.49',
    rate: '14.250000',
    installment: '4663.84',
    interest: '2670.37',
    principal: '1993.47',
    lump: '0.00',
    skip_flag: false,
    payment: '4663.84',
    closing: '222880.02',
    st_liability: '20000.00',
    extrapolated: false,
    nca_flagged: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── previewSchedule ───────────────────────────────────────────────────────────

describe('previewSchedule', () => {
  it('returns schedule rows without persisting', async () => {
    // loan lookup + events + rate points
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])    // getLoanById
      .mockResolvedValueOnce([])                  // getLoanEvents
      .mockResolvedValueOnce([                    // getRatePointsForCurve
        { id: 'p1', curve_id: CURVE_ID, effective_date: '2026-01-01', rate: '10.25' },
      ]);

    const rows = await previewSchedule(COMPANY_ID, LOAN_ID);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      period: 1,
      opening: expect.any(Number),
      interest: expect.any(Number),
      payment: expect.any(Number),
    });
    // Verify NOT persisted — only 3 sql calls (no insert)
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('throws when loan not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(previewSchedule(COMPANY_ID, LOAN_ID)).rejects.toThrow('not found');
  });

  it('uses provided events override instead of DB events', async () => {
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])
      .mockResolvedValueOnce([
        { id: 'p1', curve_id: CURVE_ID, effective_date: '2026-01-01', rate: '10.25' },
      ]);

    const overrideEvents = [{ kind: 'LUMP' as const, date: '2026-06-15', amount: 125_000 }];
    const rows = await previewSchedule(COMPANY_ID, LOAN_ID, overrideEvents);
    const lumpRow = rows.find((r) => r.lump > 0);
    expect(lumpRow).toBeDefined();
    expect(lumpRow!.lump).toBeCloseTo(125_000, 2);
    // Only 2 sql calls: loan + rate points (events supplied by caller)
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });
});

// ── getOrComputeSchedule ──────────────────────────────────────────────────────

describe('getOrComputeSchedule', () => {
  it('returns cached schedule when hash matches', async () => {
    const rows = [makeScheduleRowDb(1), makeScheduleRowDb(2)];
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])          // loan
      .mockResolvedValueOnce([])                        // events
      .mockResolvedValueOnce([                          // rate points
        { id: 'p1', curve_id: CURVE_ID, effective_date: '2026-01-01', rate: '10.25' },
      ])
      .mockResolvedValueOnce([makeRunRow()])             // latest run
      .mockResolvedValueOnce(rows);                      // cached rows

    const result = await getOrComputeSchedule(COMPANY_ID, LOAN_ID);
    expect(result.rows).toHaveLength(2);
    expect(result.cached).toBe(true);
    expect(result.rows[0]!.period).toBe(1);
  });

  it('recomputes and persists when no cached run exists', async () => {
    sqlMock
      .mockResolvedValueOnce([makeLoanRow()])    // loan
      .mockResolvedValueOnce([])                  // events
      .mockResolvedValueOnce([                    // rate points
        { id: 'p1', curve_id: CURVE_ID, effective_date: '2026-01-01', rate: '10.25' },
      ])
      .mockResolvedValueOnce([])                  // no cached run
      .mockResolvedValueOnce([makeRunRow()])       // insert run
      .mockResolvedValue([]);                      // row inserts (many)

    const result = await getOrComputeSchedule(COMPANY_ID, LOAN_ID);
    expect(result.cached).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('throws when loan not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(getOrComputeSchedule(COMPANY_ID, LOAN_ID)).rejects.toThrow('not found');
  });
});

// ── getPortfolioSummary ───────────────────────────────────────────────────────

describe('getPortfolioSummary', () => {
  it('returns portfolio KPIs', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        total_loans: '5',
        total_outstanding: '1500000.00',
        total_outstanding_projected: '1520000.00',
        weighted_avg_rate: '14.25',
        next_12m_interest: '125000.00',
        total_current_portion: '300000.00',
        active_count: '4',
        closed_count: '1',
      },
    ]);

    const summary = await getPortfolioSummary(COMPANY_ID);
    expect(summary).toMatchObject({
      totalLoans: 5,
      totalOutstanding: 1_500_000,
      totalOutstandingProjected: 1_520_000,
      weightedAvgRate: 14.25,
      next12mInterest: 125_000,
      totalCurrentPortion: 300_000,
      activeCount: 4,
      closedCount: 1,
    });
  });

  it('returns zero values when no loans exist', async () => {
    sqlMock.mockResolvedValueOnce([{
      total_loans: '0',
      total_outstanding: null,
      total_outstanding_projected: null,
      weighted_avg_rate: null,
      next_12m_interest: null,
      total_current_portion: null,
      active_count: '0',
      closed_count: '0',
    }]);
    const summary = await getPortfolioSummary(COMPANY_ID);
    expect(summary.totalLoans).toBe(0);
    expect(summary.totalOutstanding).toBe(0);
    expect(summary.weightedAvgRate).toBe(0);
  });
});
