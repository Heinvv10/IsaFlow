/**
 * Review S2: a financial year the registry cannot place (a date too far from the stored years,
 * no free label, no usable start month, no row at all) is a TrackingError 4xx, never a 500; any
 * other failure (a broken connection, a SQL bug) still propagates. The registry is mocked: this
 * is the mapping in `trackingWindow.registryYears`.
 */
import { describe, expect, it, vi } from 'vitest';

const fiscalYearForDate = vi.fn();
const getFiscalYear = vi.fn();
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/fiscalYearRegistry')>()),
  fiscalYearForDate: (...a: unknown[]) => fiscalYearForDate(...a),
  getFiscalYear: (...a: unknown[]) => getFiscalYear(...a),
}));

import { registryYears } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

async function statusOf(p: Promise<unknown>): Promise<unknown> {
  const err = await p.then(() => null, (e: unknown) => e);
  return err instanceof TrackingError ? err.status : err;
}

describe('registryYears maps a registry miss to a 4xx', () => {
  const src = registryYears('11111111-1111-4111-8111-111111111111');
  it.each([
    ['no row for the date', new Error('fiscalYearForDate: no fiscal year for company c on 2400-01-01'), 400],
    ['a date too far from the stored years', pgError('P0001', 'fiscal_year_template: 2199-01-01 is too far from the stored years'), 400],
    ['no free label', pgError('P0001', 'fiscal_year_template: no free label for the year holding 2026-01-01 (between FY2026 and FY2026)'), 400],
    ['no usable start month', pgError('22023', 'Company c has no usable financial_year_start (found NULL)'), 409],
  ])('%s', async (_name, err, status) => {
    fiscalYearForDate.mockRejectedValueOnce(err);
    expect(await statusOf(src.forDate('2026-01-01'))).toBe(status);
    getFiscalYear.mockRejectedValueOnce(err);
    expect(await statusOf(src.byLabel(2026))).toBe(status);
  });

  it('anything else propagates unchanged (a 500), never swallowed as a refusal', async () => {
    const boom = pgError('08006', 'connection failure');
    fiscalYearForDate.mockRejectedValueOnce(boom);
    expect(await statusOf(src.forDate('2026-01-01'))).toBe(boom);
    const other = pgError('P0001', 'some other raise');
    getFiscalYear.mockRejectedValueOnce(other);
    expect(await statusOf(src.byLabel(2026))).toBe(other);
  });
});
