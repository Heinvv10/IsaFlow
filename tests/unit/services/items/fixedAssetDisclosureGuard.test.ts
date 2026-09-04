/**
 * The guard on the figures reported OUTSIDE the reconciling identity.
 *
 * `difference`, `itemsTotal` and `unexplainedDifference` are checked by an
 * arithmetic a mutation can break. `unsubtypedAccountBalance`,
 * `unpostedDisposalGainLoss` and `unpostedDisposalBookValue` sit outside it by
 * design — the facts they carry do not belong inside a register-versus-ledger
 * reconciliation — and they kept the authority of the guarded numbers while
 * losing the guard. One of them then double-counted on a data shape the schema
 * permits, which is how the class was found.
 *
 * `disclosureFault` is the restored half of that discipline. It cannot check the
 * QUERY (a row the predicate never matched is invisible to everything), but it
 * can check a total against the rows it is a total of.
 *
 * WHY THIS FILE EXISTS AT ALL. The duplicate-asset guard is now unreachable
 * through the real query — `DISTINCT ON (a.id)` makes two rows for one asset
 * impossible — so a mutation of the production code leaves it green and it
 * reads as decoration. Driving the service with a stubbed query is the only way
 * to prove the guard fires, and a guard that has never been seen to fire is not
 * a guard. It is defence in depth against exactly the regression that just
 * happened: a change to that query reintroducing the duplicate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/items/fixedAssetReconciliationQueries', () => ({
  ASSET_COST_SUBTYPE: 'fixed_assets',
  ASSET_ACCUMULATED_DEPRECIATION_SUBTYPE: 'accumulated_depreciation',
  loadAssetSectionAccounts: vi.fn(),
  loadAssetSectionDocuments: vi.fn(),
  loadUnsubtypedAssetAccounts: vi.fn(),
  hasRegisterLinkage: vi.fn(),
}));
vi.mock('@/modules/accounting/services/items/fixedAssetDisposalQueries', () => ({
  loadUnpostedDisposals: vi.fn(),
}));
vi.mock('@/modules/accounting/services/items/assetRegisterService', () => ({
  getAssetRegister: vi.fn(),
  ASSET_COST_SUBTYPE: 'fixed_assets',
  ASSET_ACCUMULATED_DEPRECIATION_SUBTYPE: 'accumulated_depreciation',
}));

import {
  loadAssetSectionAccounts,
  loadAssetSectionDocuments,
  loadUnsubtypedAssetAccounts,
  hasRegisterLinkage,
} from '@/modules/accounting/services/items/fixedAssetReconciliationQueries';
import { loadUnpostedDisposals } from '@/modules/accounting/services/items/fixedAssetDisposalQueries';
import { getAssetRegister } from '@/modules/accounting/services/items/assetRegisterService';
import { reconcileFixedAssets } from '@/modules/accounting/services/items/fixedAssetReconciliationService';

const COMPANY = '22222222-2222-2222-2222-222222222222';

const EMPTY_REGISTER = {
  rows: [], rowsTotal: 0, universeTotal: 0, disposed: [],
  totals: { cost: 0, accumulatedDepreciation: 0, netBookValue: 0 },
  hasMore: false,
};

const disposal = (assetId: string, gainLoss: number) => ({
  assetId,
  assetNumber: `A-${assetId}`,
  name: 'Sold',
  disposalId: `d-${gainLoss}`,
  disposalDate: '2026-04-12',
  proceeds: 8000,
  bookValueAtDisposal: 15000,
  gainLoss,
  disposalRecordMissing: false,
  disposalRecordCount: 2,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAssetSectionAccounts).mockResolvedValue([]);
  vi.mocked(loadAssetSectionDocuments).mockResolvedValue([]);
  vi.mocked(loadUnsubtypedAssetAccounts).mockResolvedValue([]);
  vi.mocked(loadUnpostedDisposals).mockResolvedValue([]);
  vi.mocked(hasRegisterLinkage).mockResolvedValue(false);
  vi.mocked(getAssetRegister).mockResolvedValue(EMPTY_REGISTER);
});

describe('disclosureFault', () => {
  it('is ABSENT when every outside figure agrees with its own rows', async () => {
    vi.mocked(loadUnpostedDisposals).mockResolvedValue([disposal('a1', -7000)]);
    const rec = await reconcileFixedAssets(COMPANY, '2026-08-31');

    expect(rec.disclosureFault).toBeUndefined();
    expect(rec.unpostedDisposalGainLoss).toBeCloseTo(-7000, 2);
  });

  it('FIRES when one asset appears twice, and names the overstatement', async () => {
    // Exactly what the LEFT JOIN produced before DISTINCT ON: two disposal
    // rows for one asset, both summed, both headline figures doubled.
    vi.mocked(loadUnpostedDisposals).mockResolvedValue([
      disposal('a1', -7000), disposal('a1', -6500),
    ]);
    const rec = await reconcileFixedAssets(COMPANY, '2026-08-31');

    expect(rec.disclosureFault).toMatch(/2 rows for 1 assets/);
    expect(rec.disclosureFault).toMatch(/overstated/);
    // The wrong total is still REPORTED rather than suppressed — the reader is
    // told it is wrong, which is more use than an error that says nothing.
    expect(rec.unpostedDisposalGainLoss).toBeCloseTo(-13500, 2);
  });

  it('does not fire for two DIFFERENT assets carrying disposals', async () => {
    vi.mocked(loadUnpostedDisposals).mockResolvedValue([
      disposal('a1', -7000), disposal('a2', -6500),
    ]);
    const rec = await reconcileFixedAssets(COMPANY, '2026-08-31');

    expect(rec.disclosureFault).toBeUndefined();
    expect(rec.unpostedDisposalGainLoss).toBeCloseTo(-13500, 2);
  });
});
