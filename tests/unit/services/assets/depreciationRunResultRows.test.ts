/**
 * K-029 round-5 review MEDIUM-K: a rolled-back period on a LIFE-EXPIRED asset.
 *
 * `entryId: null` is shared by three different outcomes — posted nothing
 * because the charge is zero, posted nothing because the life has expired, and
 * the period rolled back. The page could not tell the third from the second, so
 * a genuine failure on an expired asset rendered as a quiet "No charge". The
 * row now carries `glFailed` explicitly; this pins that the service sets it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const postDual = vi.fn();
vi.mock('@/modules/accounting/services/gl/glCrossModuleHooks', () => ({
  postDualDepreciationToLedger: (...a: unknown[]) => postDual(...a),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { executeDepreciationRun } from '@/modules/accounting/services/items/depreciationRunService';
import type { DepreciationPlan } from '@/modules/accounting/services/items/depreciationRunPlan';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const USER = 'ffffffff-0000-4000-8000-ffffffffffff';
const ASSET = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const NOTE = 'Its 5-year life ended before 2026-09-30 with 60000.00 still undepreciated.';

const assets = [{
  id: ASSET, asset_number: 'A-0001', name: 'Expired plant', status: 'available',
  cost: 100_000, purchase_date: '2015-01-31', policy_acc_dep: 40_000, tax_acc_dep: 0,
  tax_opening_acc_dep: 0, deferred_tax_rate: 0.27, disposal_date: null,
  useful_life_years: 5, residual_pct: 0, tax_life_years: 5,
  depreciation_method: 'straight_line', below_threshold: false,
}];

function plan(lifeExpiredNote?: string): DepreciationPlan {
  const row = {
    assetId: ASSET, assetNumber: 'A-0001', name: 'Expired plant', cost: 100_000,
    entryNumber: 'DEP-A-0001-2026-09', skipReason: null, skipDetail: null,
    ...(lifeExpiredNote ? { lifeExpiredNote } : {}),
  };
  return {
    periodDate: '2026-09-30', yyyymm: '202609', fiscalPeriodId: 'fp-1', blocker: null,
    rows: [row], postable: [row], eligibleTotal: 1,
  };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('executeDepreciationRun — glFailed on the result row', () => {
  it('flags a rolled-back period on a life-expired asset, note and all', async () => {
    postDual.mockResolvedValue({ policyDep: 0, taxDep: 0, entryId: null, glFailed: true });

    const run = await executeDepreciationRun(COMPANY, USER, plan(NOTE), assets);

    expect(run.glFailed).toBe(1);
    expect(run.results).toHaveLength(1);
    // Both facts on one row: it failed, AND its life had expired. Reporting
    // only the second is what painted the failure grey.
    expect(run.results[0]!.glFailed).toBe(true);
    expect(run.results[0]!.lifeExpiredNote).toBe(NOTE);
    expect(run.results[0]!.entryId).toBeNull();
  });

  it('does not flag a life-expired asset that merely has nothing to charge', async () => {
    postDual.mockResolvedValue({ policyDep: 0, taxDep: 0, entryId: null, glFailed: false });

    const run = await executeDepreciationRun(COMPANY, USER, plan(NOTE), assets);

    expect(run.glFailed).toBe(0);
    expect(run.skipped).toBe(1);
    expect(run.results[0]!.glFailed).toBe(false);
    expect(run.results[0]!.lifeExpiredNote).toBe(NOTE);
  });

  it('does not flag a posted row', async () => {
    postDual.mockResolvedValue({ policyDep: 1666.67, taxDep: 1666.67, entryId: 'je-1', glFailed: false });

    const run = await executeDepreciationRun(COMPANY, USER, plan(), assets);

    expect(run.processed).toBe(1);
    expect(run.results[0]!.glFailed).toBe(false);
    expect(run.results[0]!.entryId).toBe('je-1');
    expect(run.results[0]!.lifeExpiredNote).toBeUndefined();
  });
});
