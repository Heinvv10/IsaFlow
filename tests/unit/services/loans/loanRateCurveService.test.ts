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
  listRateCurves,
  getRateCurveWithPoints,
  createRateCurve,
  upsertRatePoints,
  getRatePointsForCurve,
} from '@/modules/accounting/services/loans/loanRateCurveService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CURVE_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeCurveRow(overrides = {}) {
  return {
    id: CURVE_ID,
    company_id: COMPANY_ID,
    name: 'SA Prime',
    source: 'SARB',
    is_system: false,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePointRow(overrides = {}) {
  return {
    id: 'cccccccc-0000-0000-0000-000000000003',
    curve_id: CURVE_ID,
    effective_date: '2026-01-01',
    rate: '10.25',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── listRateCurves ────────────────────────────────────────────────────────────

describe('listRateCurves', () => {
  it('returns mapped curves for company', async () => {
    sqlMock.mockResolvedValueOnce([makeCurveRow()]);
    const result = await listRateCurves(COMPANY_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: CURVE_ID, name: 'SA Prime', companyId: COMPANY_ID });
  });

  it('returns empty array when no curves exist', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await listRateCurves(COMPANY_ID);
    expect(result).toEqual([]);
  });

  it('includes system-level curves alongside company curves', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 'sys-1', company_id: null, name: 'SA Prime', source: 'SARB', is_system: true, created_at: 't' },
      makeCurveRow({ name: 'Custom' }),
    ]);
    const result = await listRateCurves(COMPANY_ID);
    expect(result).toHaveLength(2);
    expect(result[0]!.isSystem).toBe(true);
    expect(result[0]!.companyId).toBeNull();
    expect(result[1]!.companyId).toBe(COMPANY_ID);
  });
});

// ── getRateCurveWithPoints ────────────────────────────────────────────────────

describe('getRateCurveWithPoints', () => {
  it('returns curve with sorted rate points', async () => {
    sqlMock
      .mockResolvedValueOnce([makeCurveRow()])
      .mockResolvedValueOnce([
        makePointRow({ effective_date: '2026-03-01', rate: '11.00' }),
        makePointRow({ effective_date: '2026-01-01', rate: '10.25' }),
      ]);
    const result = await getRateCurveWithPoints(COMPANY_ID, CURVE_ID);
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(2);
    expect(result!.points[0]!.effectiveDate).toBe('2026-01-01');
    expect(result!.points[1]!.effectiveDate).toBe('2026-03-01');
  });

  it('returns null when curve not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getRateCurveWithPoints(COMPANY_ID, CURVE_ID);
    expect(result).toBeNull();
  });

  it('points query uses a company-scoped JOIN (defence-in-depth)', async () => {
    sqlMock
      .mockResolvedValueOnce([makeCurveRow()])
      .mockResolvedValueOnce([]);
    await getRateCurveWithPoints(COMPANY_ID, CURVE_ID);
    // Second call must include company_id in its bindings — the JOIN makes it
    // impossible for a stolen curveId to leak points from another tenant even
    // if the first-query ownership check was somehow bypassed.
    const secondCall = sqlMock.mock.calls[1];
    const bindings = Array.isArray(secondCall) ? secondCall.slice(1).flat() : [];
    expect(bindings).toContain(COMPANY_ID);
  });

  it('returns a system-level curve even when company_id does not match', async () => {
    // System curves (company_id IS NULL, is_system = true) are readable by all.
    const systemCurve = { id: 'sys-1', company_id: null, name: 'SA Prime', source: 'SARB', is_system: true, created_at: 't' };
    sqlMock
      .mockResolvedValueOnce([systemCurve])
      .mockResolvedValueOnce([makePointRow({ curve_id: 'sys-1' })]);
    const result = await getRateCurveWithPoints(COMPANY_ID, 'sys-1');
    expect(result).not.toBeNull();
    expect(result!.isSystem).toBe(true);
    expect(result!.points).toHaveLength(1);
  });
});

// ── createRateCurve ───────────────────────────────────────────────────────────

describe('createRateCurve', () => {
  it('inserts and returns new curve', async () => {
    sqlMock.mockResolvedValueOnce([makeCurveRow({ name: 'JIBAR' })]);
    const result = await createRateCurve(COMPANY_ID, { name: 'JIBAR', source: 'SARB' });
    expect(result).toMatchObject({ name: 'JIBAR', companyId: COMPANY_ID });
  });

  it('throws when name is empty', async () => {
    await expect(createRateCurve(COMPANY_ID, { name: '' })).rejects.toThrow('name');
  });
});

// ── upsertRatePoints ──────────────────────────────────────────────────────────

describe('upsertRatePoints', () => {
  it('inserts batch of rate points and returns count', async () => {
    const points = [
      { effectiveDate: '2026-01-01', rate: 10.25 },
      { effectiveDate: '2026-03-01', rate: 11.00 },
    ];
    sqlMock
      .mockResolvedValueOnce([{ id: CURVE_ID }])  // ownership check passes
      .mockResolvedValueOnce([])                   // upsert point 1
      .mockResolvedValueOnce([]);                  // upsert point 2
    const count = await upsertRatePoints(COMPANY_ID, CURVE_ID, points);
    expect(count).toBe(2);
  });

  it('throws when points array is empty', async () => {
    await expect(upsertRatePoints(COMPANY_ID, CURVE_ID, [])).rejects.toThrow('at least one');
  });

  it('throws when rate is not positive', async () => {
    await expect(
      upsertRatePoints(COMPANY_ID, CURVE_ID, [{ effectiveDate: '2026-01-01', rate: 0 }]),
    ).rejects.toThrow('positive');
  });

  it('throws when curve belongs to a different company (IDOR guard)', async () => {
    sqlMock.mockResolvedValueOnce([]);  // ownership check returns empty — not our curve
    await expect(
      upsertRatePoints(COMPANY_ID, CURVE_ID, [{ effectiveDate: '2026-01-01', rate: 10 }]),
    ).rejects.toThrow('not found');
  });
});

// ── getRatePointsForCurve ─────────────────────────────────────────────────────

describe('getRatePointsForCurve', () => {
  it('returns rate points sorted by effective_date', async () => {
    sqlMock.mockResolvedValueOnce([
      makePointRow({ effective_date: '2026-01-01', rate: '10.25' }),
      makePointRow({ effective_date: '2025-11-01', rate: '10.00' }),
    ]);
    const points = await getRatePointsForCurve(COMPANY_ID, CURVE_ID);
    expect(points[0]!.effectiveDate).toBe('2025-11-01');
    expect(points[1]!.effectiveDate).toBe('2026-01-01');
    expect(points[0]!.rate).toBeCloseTo(10.0, 4);
  });
});
