/**
 * Review round 2, L3: a registry raise inside the named version's year lookup (`versionYear`) is
 * mapped like every other registry miss (TrackingError 4xx), never a 500; P1's own typed refusal
 * (BudgetVersionError) and any other error pass through unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

const versionYear = vi.fn();
vi.mock('@/modules/accounting/services/budgets/budgetVersionScope', () => ({
  versionYear: (...a: unknown[]) => versionYear(...a),
}));

import { resolveTrackingVersions } from '@/modules/accounting/services/budgets/tracking/trackingBudgetRead';
import { TrackingError, type TrackingWindow } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';

const FY = { id: 'y', fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', status: 'open', kind: 'normal', stored: true, months: 12, assumed: false } as const;
const WINDOW: TrackingWindow = {
  period: 'fy', label: 'FY2027', startDate: FY.startDate, endDate: FY.endDate, months: [], fiscalYear: 2027,
  fy: FY as TrackingWindow['fy'], years: [{ fiscalYear: 2027, months: ['2026-03'] }], inProgressMonth: null, notStarted: false,
};
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const VID = '11111111-1111-4111-8111-111111111111';

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => null, (e: unknown) => e);
}

describe('resolveTrackingVersions: the named version lookup', () => {
  it("maps the registry's template raise to a TrackingError 400", async () => {
    versionYear.mockRejectedValueOnce(pgError('P0001', 'fiscal_year_template: 2700-01-01 is too far from the stored years'));
    const err = await caught(resolveTrackingVersions('c', WINDOW, VID));
    expect(err).toBeInstanceOf(TrackingError);
    expect((err as TrackingError).status).toBe(400);
  });

  it("leaves P1's typed refusal and any other error as they are", async () => {
    const notFound = new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
    versionYear.mockRejectedValueOnce(notFound);
    expect(await caught(resolveTrackingVersions('c', WINDOW, VID))).toBe(notFound);
    const boom = pgError('08006', 'connection failure');
    versionYear.mockRejectedValueOnce(boom);
    expect(await caught(resolveTrackingVersions('c', WINDOW, VID))).toBe(boom);
  });
});
