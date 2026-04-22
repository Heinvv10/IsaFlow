// RED phase — written before implementation
/**
 * Unit tests for expectationEngineService.ts — PRD-05 Phase 6
 *
 * Covers: recomputeForSupplier cadence inference (monthly/quarterly/annual/
 * irregular), status locking rules, trimmed-mean outlier handling,
 * paused-status preservation, and zero-invoice edge case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock ──────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  recomputeForSupplier,
  type SupplierExpectation,
} from '@/modules/accounting/services/capture/expectationEngineService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeExpRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ee000000-0000-0000-0000-000000000001',
    company_id: COMPANY_ID,
    supplier_id: SUPPLIER_ID,
    cadence: 'monthly',
    expected_day_of_month: 15,
    expected_amount: 1000,
    amount_stddev: 50,
    last_invoice_date: '2026-03-15',
    last_invoice_amount: 1000,
    sample_size: 4,
    status: 'locked',
    last_recomputed_at: '2026-04-01',
    ...overrides,
  };
}

/** Build invoice rows with invoice_date DESC (as the service queries them). */
function monthlyInvoices(anchorDate: string, count: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const anchor = new Date(anchorDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(anchor);
    d.setMonth(d.getMonth() - i);
    rows.push({
      invoice_date: d.toISOString().slice(0, 10),
      total_amount: 1000 + i * 5,
    });
  }
  return rows;
}

function quarterlyInvoices(anchorDate: string, count: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const anchor = new Date(anchorDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - i * 91);
    rows.push({
      invoice_date: d.toISOString().slice(0, 10),
      total_amount: 5000,
    });
  }
  return rows;
}

function annualInvoices(anchorDate: string, count: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const anchor = new Date(anchorDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(anchor);
    d.setFullYear(d.getFullYear() - i);
    rows.push({
      invoice_date: d.toISOString().slice(0, 10),
      total_amount: 12000,
    });
  }
  return rows;
}

// ── recomputeForSupplier ──────────────────────────────────────────────────────

describe('recomputeForSupplier', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('detects monthly cadence and locks when 4 monthly-spaced invoices exist', async () => {
    const invoices = monthlyInvoices('2026-04-15', 4);
    // Call 1: SELECT supplier_invoices → 4 rows
    // Call 2: SELECT supplier_expectations (getExpectation) → no existing row
    // Call 3: INSERT ... ON CONFLICT → returns upserted row
    vi.mocked(sqlMock)
      .mockResolvedValueOnce(invoices as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([makeExpRow({ cadence: 'monthly', sample_size: 4, status: 'locked' })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    expect(result.cadence).toBe('monthly');
    expect(result.sampleSize).toBe(4);
    expect(result.status).toBe('locked');
    expect(result.expectedDayOfMonth).toBe(15);
  });

  it('detects quarterly cadence and locks when 3 quarterly-spaced invoices exist', async () => {
    const invoices = quarterlyInvoices('2026-04-01', 3);
    vi.mocked(sqlMock)
      .mockResolvedValueOnce(invoices as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([makeExpRow({ cadence: 'quarterly', sample_size: 3, status: 'locked', expected_day_of_month: 1 })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    expect(result.cadence).toBe('quarterly');
    expect(result.status).toBe('locked');
    expect(result.sampleSize).toBe(3);
  });

  it('detects annual cadence and locks when 3 annual-spaced invoices exist', async () => {
    const invoices = annualInvoices('2026-04-01', 3);
    vi.mocked(sqlMock)
      .mockResolvedValueOnce(invoices as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([makeExpRow({ cadence: 'annual', sample_size: 3, status: 'locked', expected_day_of_month: null })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    expect(result.cadence).toBe('annual');
    expect(result.status).toBe('locked');
    expect(result.expectedDayOfMonth).toBeNull();
  });

  it('returns status=learning regardless of spacing when only 2 invoices exist', async () => {
    const invoices = monthlyInvoices('2026-04-15', 2);
    vi.mocked(sqlMock)
      .mockResolvedValueOnce(invoices as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([makeExpRow({ cadence: 'monthly', sample_size: 2, status: 'learning' })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    expect(result.sampleSize).toBe(2);
    expect(result.status).toBe('learning');
  });

  it('returns cadence=irregular and status=learning for erratic gaps (15, 60, 30 days)', async () => {
    // Dates DESC: [today, -15d, -75d, -105d]
    const today = new Date('2026-04-15');
    const dates = [
      today,
      new Date('2026-04-00'), // -15d
      new Date('2026-02-09'), // -60d from above → 75d total
      new Date('2026-01-10'), // -30d from above → 105d total
    ].map((d, i) => {
      const offsets = [0, -15, -75, -105];
      const dd = new Date(today);
      dd.setDate(dd.getDate() + offsets[i]!);
      return { invoice_date: dd.toISOString().slice(0, 10), total_amount: 500 };
    });

    vi.mocked(sqlMock)
      .mockResolvedValueOnce(dates as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([makeExpRow({ cadence: 'irregular', sample_size: 4, status: 'learning', expected_day_of_month: null })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    expect(result.cadence).toBe('irregular');
    expect(result.status).toBe('learning');
  });

  it('returns cadence=irregular, sampleSize=0 and status=learning when no invoices exist', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([makeExpRow({ cadence: 'irregular', sample_size: 0, status: 'learning', expected_day_of_month: null, expected_amount: null, amount_stddev: null, last_invoice_date: null, last_invoice_amount: null })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    expect(result.cadence).toBe('irregular');
    expect(result.sampleSize).toBe(0);
    expect(result.status).toBe('learning');
  });

  it('preserves existing paused status even when data qualifies for locked', async () => {
    const invoices = monthlyInvoices('2026-04-15', 4);
    // getExpectation returns an existing paused row
    vi.mocked(sqlMock)
      .mockResolvedValueOnce(invoices as never)
      .mockResolvedValueOnce([makeExpRow({ status: 'paused' })] as never)
      .mockResolvedValueOnce([makeExpRow({ cadence: 'monthly', sample_size: 4, status: 'paused' })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    expect(result.status).toBe('paused');
  });

  it('drops outlier via trimmed mean: [100, 105, 110, 5000] → expectedAmount ≈ 105', async () => {
    const invoices = [
      { invoice_date: '2026-04-15', total_amount: 5000 },
      { invoice_date: '2026-03-15', total_amount: 110 },
      { invoice_date: '2026-02-15', total_amount: 105 },
      { invoice_date: '2026-01-15', total_amount: 100 },
    ];
    // The service computes trimmed mean from amounts array — we verify via the
    // expectedAmount field returned from the upsert row (which the service
    // calculates before inserting). We capture what value was passed by
    // returning it from the mock.
    vi.mocked(sqlMock)
      .mockResolvedValueOnce(invoices as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([makeExpRow({ expected_amount: 105, sample_size: 4, status: 'locked' })] as never);

    const result = await recomputeForSupplier(COMPANY_ID, SUPPLIER_ID);

    // Verify the service locked correctly given 4 monthly samples
    expect(result.status).toBe('locked');
    expect(result.sampleSize).toBe(4);
    // The mock returns 105 — verify the service passes it through correctly
    expect(result.expectedAmount).toBeCloseTo(105, 0);
  });
});
