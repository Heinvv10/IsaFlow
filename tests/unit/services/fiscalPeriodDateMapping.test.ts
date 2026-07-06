/**
 * TDD (RED first): fiscalPeriodService date mapping must not roll pg DATE
 * values back a day.
 *
 * pg returns DATE columns as Date objects at LOCAL midnight. mapRow used
 * toISODate() (UTC-based) which, on this UTC+2 server, formats local-midnight
 * 2026-03-01 as "2026-02-28" — the period boundaries displayed a day early
 * while the DB was correct. Fix: fmtDate() (local components). See
 * [[toISODate-utc-rollback]].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withTransaction: vi.fn(),
  // real-behaving fmtDate (local components) — same as src/lib/neon
  fmtDate: (d: unknown) =>
    d instanceof Date
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : String(d ?? ''),
}));

import {
  getFiscalPeriodById,
  getFiscalPeriodIdForDate,
} from '@/modules/accounting/services/gl/fiscalPeriodService';

beforeEach(() => sqlMock.mockReset());

describe('fiscalPeriodService date mapping', () => {
  it('formats pg DATE (Date at local midnight) without rolling back a day', async () => {
    sqlMock.mockResolvedValue([
      {
        id: 'p1', period_name: 'March 2026', period_number: 3, fiscal_year: 2026,
        start_date: new Date(2026, 2, 1),   // local midnight 2026-03-01
        end_date: new Date(2026, 2, 31),    // local midnight 2026-03-31
        status: 'open', closed_by: null, closed_at: null,
        created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
      },
    ]);

    const period = await getFiscalPeriodById('co-1', 'p1');
    expect(period).not.toBeNull();
    expect(period!.startDate).toBe('2026-03-01');
    expect(period!.endDate).toBe('2026-03-31');
  });

  it('passes through an ISO string date unchanged', async () => {
    sqlMock.mockResolvedValue([
      {
        id: 'p2', period_name: 'April 2026', period_number: 4, fiscal_year: 2026,
        start_date: '2026-04-01', end_date: '2026-04-30',
        status: 'open', closed_by: null, closed_at: null,
        created_at: 'x', updated_at: 'y',
      },
    ]);
    const period = await getFiscalPeriodById('co-1', 'p2');
    expect(period!.startDate).toBe('2026-04-01');
    expect(period!.endDate).toBe('2026-04-30');
  });

  it('resolves the period for a Date at local midnight WITHOUT shifting the day (correctness, not display)', async () => {
    sqlMock.mockResolvedValue([{ id: 'period-march' }]);
    // A JE dated 2026-03-01 passed as a Date must query with 2026-03-01, not
    // 2026-02-28 — else the March-boundary posting resolves February's period.
    await getFiscalPeriodIdForDate('co-1', new Date(2026, 2, 1));
    // sql is tagged: sql`... ${companyId} ... ${date}::date ...` →
    // (strings, companyId, date). Assert the date value regardless of position.
    const args = sqlMock.mock.calls[0] ?? [];
    expect(args).toContain('2026-03-01');
    expect(args).not.toContain('2026-02-28');
  });
});
