// RED phase — written before implementation
/**
 * Unit tests for cashFlowForecastService.ts
 *
 * getActualCashFlow — tested via mocked sql (returns CashFlowPeriod[])
 * getForecast       — additionally stubs global fetch for the Anthropic call
 *
 * Cache behaviour is verified by calling getForecast twice and asserting
 * fetch is called only once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  getActualCashFlow,
  getForecast,
} from '@/modules/accounting/services/reports/cashFlowForecastService';
import type { CashFlowPeriod, CashFlowForecast } from '@/modules/accounting/services/reports/cashFlowForecastService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// Each getForecast test needs a unique companyId to avoid hitting the 4-hour
// module-level in-memory cache left by previous tests in the same run.
let _uidCounter = 1;
function freshId(): string {
  const hex = String(_uidCounter++).padStart(12, '0');
  return `ffff0000-0000-0000-0000-${hex}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWeekRow(overrides: Record<string, unknown> = {}) {
  return {
    week_start: '2026-04-07',
    inflows: 50_000,
    outflows: 30_000,
    net_flow: 20_000,
    ...overrides,
  };
}

/** Builds a mock Anthropic API response with a single forecast week. */
function makeMockAnthropicResponse(weekStart = '2026-04-14') {
  return {
    ok: true,
    json: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            forecast: [
              {
                weekStart,
                projectedInflows: 50_000,
                projectedOutflows: 30_000,
                projectedNet: 20_000,
                confidence: 'high',
                notes: 'Strong AR collections expected',
              },
            ],
            summary: 'Healthy cash position with good AR pipeline',
            risks: ['Late payer risk on Invoice #123'],
            opportunities: ['Early settlement discounts available'],
          }),
        },
      ],
    }),
  };
}

/**
 * Mocks all sql calls needed by getForecast in order:
 * 1. getActualCashFlow (bank_transactions)
 * 2. getBankBalance (bank_transactions SUM)
 * 3. getUpcomingReceivablesAndPayables → customer_invoices
 * 4. getUpcomingReceivablesAndPayables → supplier_invoices
 * 5. getRecurringTemplates
 */
function setupForecastSqlMocks(weekRows: Record<string, unknown>[] = [makeWeekRow()]) {
  vi.mocked(sql)
    .mockResolvedValueOnce(weekRows)                      // 1. actual cash flow
    .mockResolvedValueOnce([{ balance: 100_000 }])        // 2. bank balance
    .mockResolvedValueOnce([])                            // 3. receivables
    .mockResolvedValueOnce([])                            // 4. payables
    .mockResolvedValueOnce([]);                           // 5. recurring templates
}

// ── getActualCashFlow ─────────────────────────────────────────────────────────

describe('getActualCashFlow', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('returns an empty array when no bank transactions exist', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await getActualCashFlow(COMPANY_ID, 90);

    expect(result).toEqual([]);
  });

  it('returns an array of CashFlowPeriod objects', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeWeekRow()]);

    const result = await getActualCashFlow(COMPANY_ID, 90);

    expect(result).toHaveLength(1);
    const period = result[0]!;
    expect(period).toHaveProperty('weekStart');
    expect(period).toHaveProperty('inflows');
    expect(period).toHaveProperty('outflows');
    expect(period).toHaveProperty('netFlow');
    expect(period).toHaveProperty('runningBalance');
  });

  it('maps inflows, outflows, and netFlow from DB row', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeWeekRow({ inflows: 80_000, outflows: 45_000, net_flow: 35_000 }),
    ]);

    const result = await getActualCashFlow(COMPANY_ID, 90);

    expect(result[0]!.inflows).toBe(80_000);
    expect(result[0]!.outflows).toBe(45_000);
    expect(result[0]!.netFlow).toBe(35_000);
  });

  it('runningBalance is cumulative across periods', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeWeekRow({ week_start: '2026-03-31', net_flow: 10_000 }),
      makeWeekRow({ week_start: '2026-04-07', net_flow: 20_000 }),
      makeWeekRow({ week_start: '2026-04-14', net_flow: -5_000 }),
    ]);

    const result = await getActualCashFlow(COMPANY_ID, 90);

    expect(result[0]!.runningBalance).toBe(10_000);
    expect(result[1]!.runningBalance).toBe(30_000);
    expect(result[2]!.runningBalance).toBe(25_000);
  });

  it('first period runningBalance equals its own netFlow (no prior balance)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeWeekRow({ net_flow: 15_000 }),
    ]);

    const result = await getActualCashFlow(COMPANY_ID, 90);

    expect(result[0]!.runningBalance).toBe(15_000);
  });

  it('passes companyId as interpolated argument to the query', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await getActualCashFlow(COMPANY_ID, 30);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(COMPANY_ID);
  });

  it('passes lookbackDays as interpolated argument to the query', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await getActualCashFlow(COMPANY_ID, 60);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(60);
  });

  it('weekStart is a date string in YYYY-MM-DD format', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeWeekRow()]);

    const result = await getActualCashFlow(COMPANY_ID, 90);

    expect(result[0]!.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('handles negative netFlow (net outflow weeks)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeWeekRow({ net_flow: -12_000, inflows: 5_000, outflows: 17_000 }),
    ]);

    const result = await getActualCashFlow(COMPANY_ID, 90);

    expect(result[0]!.netFlow).toBe(-12_000);
    expect(result[0]!.runningBalance).toBe(-12_000);
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('DB timeout'));

    await expect(getActualCashFlow(COMPANY_ID, 90)).rejects.toThrow('DB timeout');
  });
});

// ── getForecast ───────────────────────────────────────────────────────────────
//
// IMPORTANT: The service has a module-level in-memory forecastCache that persists
// for 4 hours. To avoid cache hits bleeding across tests we assign each test its
// own unique companyId via freshId() so every call is a guaranteed cache miss.

describe('getForecast', () => {
  beforeEach(() => {
    vi.mocked(sql).mockReset();
    // Ensure ANTHROPIC_API_KEY is set so the service doesn't short-circuit
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a CashFlowForecast with correct shape', async () => {
    const id = freshId();
    setupForecastSqlMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockAnthropicResponse()));

    const result = await getForecast(id, 30);

    expect(result).toHaveProperty('companyId', id);
    expect(result).toHaveProperty('generatedAt');
    expect(result).toHaveProperty('horizonDays');
    expect(result).toHaveProperty('historicalPeriods');
    expect(result).toHaveProperty('forecastPeriods');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('risks');
    expect(result).toHaveProperty('opportunities');
    expect(result).toHaveProperty('currentCashBalance');
    expect(result).toHaveProperty('projectedEndBalance');
  });

  it('forecastPeriods contains ForecastWeek objects with correct fields', async () => {
    setupForecastSqlMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockAnthropicResponse('2026-04-14')));

    const result = await getForecast(freshId(), 30);

    expect(result.forecastPeriods).toHaveLength(1);
    const week = result.forecastPeriods[0]!;
    expect(week.weekStart).toBe('2026-04-14');
    expect(week.projectedInflows).toBe(50_000);
    expect(week.projectedOutflows).toBe(30_000);
    expect(week.projectedNet).toBe(20_000);
    expect(week.confidence).toBe('high');
    expect(typeof week.notes).toBe('string');
  });

  it('risks and opportunities are string arrays from the AI response', async () => {
    setupForecastSqlMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockAnthropicResponse()));

    const result = await getForecast(freshId(), 30);

    expect(Array.isArray(result.risks)).toBe(true);
    expect(Array.isArray(result.opportunities)).toBe(true);
    expect(result.risks[0]).toBe('Late payer risk on Invoice #123');
    expect(result.opportunities[0]).toBe('Early settlement discounts available');
  });

  it('summary is a non-empty string', async () => {
    setupForecastSqlMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockAnthropicResponse()));

    const result = await getForecast(freshId(), 30);

    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('historicalPeriods reflects actual cash flow data from DB', async () => {
    setupForecastSqlMocks([
      makeWeekRow({ week_start: '2026-03-31', net_flow: 10_000 }),
      makeWeekRow({ week_start: '2026-04-07', net_flow: 5_000 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockAnthropicResponse()));

    const result = await getForecast(freshId(), 30);

    expect(result.historicalPeriods).toHaveLength(2);
  });

  it('cache hit: calling getForecast twice with same args only fetches once', async () => {
    // Use a stable ID for both calls so the second one hits the cache
    const stableId = freshId();
    setupForecastSqlMocks();
    const mockFetch = vi.fn().mockResolvedValue(makeMockAnthropicResponse());
    vi.stubGlobal('fetch', mockFetch);

    const first = await getForecast(stableId, 30);
    // Second call with same companyId + horizonDays → cache hit, no fetch
    const second = await getForecast(stableId, 30);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(first.generatedAt).toBe(second.generatedAt);
  });

  it('different horizonDays use separate cache keys (no cross-horizon bleed)', async () => {
    // Use same companyId but different horizons — each must miss the cache
    const stableId = freshId();
    setupForecastSqlMocks();
    const mockFetch = vi.fn().mockResolvedValue(makeMockAnthropicResponse());
    vi.stubGlobal('fetch', mockFetch);

    await getForecast(stableId, 30);

    // Drain sql mock for second call
    setupForecastSqlMocks();
    await getForecast(stableId, 60);

    // Each distinct horizon should trigger a fresh fetch
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('horizonDays is stored correctly on the returned forecast', async () => {
    setupForecastSqlMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockAnthropicResponse()));

    const result = await getForecast(freshId(), 90);

    expect(result.horizonDays).toBe(90);
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    // DB calls happen before the API key check — mock them first so execution
    // reaches the key guard and throws the expected error.
    setupForecastSqlMocks();
    delete process.env.ANTHROPIC_API_KEY;

    await expect(getForecast(freshId(), 30)).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('throws when Anthropic API returns a non-ok response', async () => {
    setupForecastSqlMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      })
    );

    await expect(getForecast(freshId(), 30)).rejects.toThrow('429');
  });

  it('projectedEndBalance equals currentCashBalance plus sum of all forecast projectedNet', async () => {
    setupForecastSqlMocks();
    // Bank balance is 100_000 from setupForecastSqlMocks; forecast net is 20_000
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockAnthropicResponse()));

    const result = await getForecast(freshId(), 30);

    const sumNet = result.forecastPeriods.reduce((s, w) => s + w.projectedNet, 0);
    expect(result.projectedEndBalance).toBeCloseTo(result.currentCashBalance + sumNet, 2);
  });
});
