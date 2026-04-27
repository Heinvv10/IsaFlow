/**
 * Unit tests for workbenchService.getWorkbenchMetrics
 *
 * Coverage:
 *   - Each of the 6 metrics returns the expected numeric value
 *   - company_id is the first interpolated argument in every SQL query
 *   - Cross-tenant isolation: different company_id → empty results
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getWorkbenchMetrics } from '@/modules/accounting/services/dashboard/workbenchService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The service calls sql six times in parallel (Promise.all order):
 *   0 = unreconciledBankTxns
 *   1 = draftInvoices
 *   2 = apDueThisWeek
 *   3 = unpostedJournals
 *   4 = openPriorPeriods
 *   5 = vatEstimateCurrentPeriod
 */
function mockSqlSequence(values: (number | string)[]): void {
  const sqlMock = sql as unknown as MockInstance;
  let callIdx = 0;
  sqlMock.mockImplementation(() => {
    const idx = callIdx++;
    switch (idx) {
      case 0: return Promise.resolve([{ cnt: String(values[0] ?? 0) }]);
      case 1: return Promise.resolve([{ cnt: String(values[1] ?? 0) }]);
      case 2: return Promise.resolve([{ cnt: String(values[2] ?? 0) }]);
      case 3: return Promise.resolve([{ cnt: String(values[3] ?? 0) }]);
      case 4: return Promise.resolve([{ cnt: String(values[4] ?? 0) }]);
      case 5: return Promise.resolve([{ vat_estimate: String(values[5] ?? 0) }]);
      default: return Promise.resolve([]);
    }
  });
}

function zeroMock(): void {
  mockSqlSequence([0, 0, 0, 0, 0, 0]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getWorkbenchMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Shape ──────────────────────────────────────────────────────────────────

  it('returns an object with all six metric keys', async () => {
    zeroMock();
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m).toHaveProperty('unreconciledBankTxns');
    expect(m).toHaveProperty('draftInvoices');
    expect(m).toHaveProperty('apDueThisWeek');
    expect(m).toHaveProperty('unpostedJournals');
    expect(m).toHaveProperty('openPriorPeriods');
    expect(m).toHaveProperty('vatEstimateCurrentPeriod');
  });

  // ── Per-metric values ──────────────────────────────────────────────────────

  it('returns correct unreconciledBankTxns count', async () => {
    mockSqlSequence([7, 0, 0, 0, 0, 0]);
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.unreconciledBankTxns).toBe(7);
  });

  it('returns correct draftInvoices count', async () => {
    mockSqlSequence([0, 12, 0, 0, 0, 0]);
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.draftInvoices).toBe(12);
  });

  it('returns correct apDueThisWeek count', async () => {
    mockSqlSequence([0, 0, 3, 0, 0, 0]);
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.apDueThisWeek).toBe(3);
  });

  it('returns correct unpostedJournals count', async () => {
    mockSqlSequence([0, 0, 0, 5, 0, 0]);
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.unpostedJournals).toBe(5);
  });

  it('returns correct openPriorPeriods count', async () => {
    mockSqlSequence([0, 0, 0, 0, 2, 0]);
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.openPriorPeriods).toBe(2);
  });

  it('returns correct vatEstimateCurrentPeriod (positive — payable)', async () => {
    mockSqlSequence([0, 0, 0, 0, 0, 15000]);
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.vatEstimateCurrentPeriod).toBe(15000);
  });

  it('returns correct vatEstimateCurrentPeriod (negative — refundable)', async () => {
    mockSqlSequence([0, 0, 0, 0, 0, -3200]);
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.vatEstimateCurrentPeriod).toBe(-3200);
  });

  it('returns zero for all metrics when DB is clean', async () => {
    zeroMock();
    const m = await getWorkbenchMetrics(COMPANY_A);
    expect(m.unreconciledBankTxns).toBe(0);
    expect(m.draftInvoices).toBe(0);
    expect(m.apDueThisWeek).toBe(0);
    expect(m.unpostedJournals).toBe(0);
    expect(m.openPriorPeriods).toBe(0);
    expect(m.vatEstimateCurrentPeriod).toBe(0);
  });

  // ── Multi-tenant: company_id is FIRST interpolated arg in every query ──────

  it('passes company_id as the first interpolated argument in every SQL call', async () => {
    zeroMock();
    await getWorkbenchMetrics(COMPANY_A);

    const sqlMock = sql as unknown as MockInstance;
    // sql is a tagged template: sql`... ${companyId}::UUID ...`
    // The mock is called as sql(strings, ...args).
    // vitest stores calls as .mock.calls[i] = [strings, arg0, arg1, ...]
    // We verify every call has COMPANY_A as the first interpolated arg.
    expect(sqlMock.mock.calls.length).toBe(6);
    for (const call of sqlMock.mock.calls) {
      // call[0] = TemplateStringsArray, call[1] = first interpolated value
      const firstArg = call[1] as string;
      expect(firstArg).toBe(COMPANY_A);
    }
  });

  // ── Cross-tenant isolation ────────────────────────────────────────────────

  it('uses the provided companyId (COMPANY_B), not a hard-coded one', async () => {
    zeroMock();
    await getWorkbenchMetrics(COMPANY_B);

    const sqlMock = sql as unknown as MockInstance;
    for (const call of sqlMock.mock.calls) {
      const firstArg = call[1] as string;
      expect(firstArg).toBe(COMPANY_B);
      expect(firstArg).not.toBe(COMPANY_A);
    }
  });

  it('returns different values for different companies (cross-tenant)', async () => {
    const sqlMock = sql as unknown as MockInstance;

    // Branch on the first interpolated argument (companyId) to prove the service
    // actually threads the caller-supplied companyId into every SQL query.
    // COMPANY_A → non-zero counts; COMPANY_B → zero counts.
    sqlMock.mockImplementation((_template: TemplateStringsArray, ...args: unknown[]) => {
      const companyId = args[0] as string;
      if (companyId === COMPANY_A) {
        // Return a generic non-zero row; vat_estimate queries use a different key
        // but Number() on undefined falls back to 0, so use cnt for all — the
        // service picks whichever key is present.
        return Promise.resolve([{ cnt: '5', vat_estimate: '9000' }]);
      }
      if (companyId === COMPANY_B) {
        return Promise.resolve([{ cnt: '0', vat_estimate: '0' }]);
      }
      return Promise.resolve([]);
    });

    const metricsA = await getWorkbenchMetrics(COMPANY_A);
    const metricsB = await getWorkbenchMetrics(COMPANY_B);

    // COMPANY_A: service reads cnt/vat_estimate from the mock → non-zero
    expect(metricsA.unreconciledBankTxns).toBe(5);
    expect(metricsA.vatEstimateCurrentPeriod).toBe(9000);

    // COMPANY_B: different tenant → all zeros
    expect(metricsB.unreconciledBankTxns).toBe(0);
    expect(metricsB.vatEstimateCurrentPeriod).toBe(0);
  });
});
