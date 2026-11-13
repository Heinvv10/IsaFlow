/**
 * assetCreateService: the extracted create behind POST /api/accounting/assets and create_fixed_asset.
 * Ordering and scoping are pinned here (the number lock precedes the MAX read; every query carries the company);
 * the real INSERT and number minting run against Postgres in tests/integration/create-fixed-asset.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/numberLock', () => ({
  ASSET_NUMBER_SEED: 864001,
  takeCompanyNumberLock: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { takeCompanyNumberLock } from '@/modules/accounting/services/core/numberLock';
import {
  createAsset,
  findSimilarAssets,
  insertPlannedAsset,
  listActiveAssetCategories,
  planAssetCreate,
} from '@/modules/accounting/services/items/assetCreateService';
import type { AssetInput } from '@/modules/accounting/services/items/assetService';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const body: AssetInput = {
  name: 'Laptop', category: 'computers', sarsCategory: 'computers', purchaseDate: '2026-03-02', cost: 1000,
  salvageValue: 0, usefulLifeYears: 3, depreciationMethod: 'straight_line',
};
const q = (i: number) => (vi.mocked(sql).mock.calls[i]![0] as unknown as string[]).join('?');
const params = (i: number) => vi.mocked(sql).mock.calls[i]!.slice(1);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('planAssetCreate', () => {
  it('resolves the category, takes the prefix lock BEFORE the MAX read, and mints max+1', async () => {
    const order: string[] = [];
    vi.mocked(takeCompanyNumberLock).mockImplementation(async () => { order.push('lock'); });
    vi.mocked(sql)
      .mockImplementationOnce((async () => { order.push('category'); return [{ id: 'cat', sars_rate: '33.33', sars_years: '3' }]; }) as never)
      .mockImplementationOnce((async () => { order.push('max'); return [{ max_num: 7 }]; }) as never);
    const plan = await planAssetCreate(COMPANY, body);
    expect(order).toEqual(['category', 'lock', 'max']);
    expect(takeCompanyNumberLock).toHaveBeenCalledWith(COMPANY, 'COMP', 864001);
    expect(plan).toEqual({ categoryId: 'cat', sarsRate: 33.33, taxLife: 3, categoryKey: 'computers', assetNumber: 'COMP-0008' });
    expect(q(1)).toMatch(/company_id = \?::UUID/);
    expect(params(1)).toContain(COMPANY);
  });

  it('an unknown category leaves the SARS fields null and keeps the code as text (the route\'s behaviour)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ max_num: 0 }] as never);
    const plan = await planAssetCreate(COMPANY, { ...body, category: 'widgets', sarsCategory: 'widgets' });
    expect(plan).toMatchObject({ categoryId: null, sarsRate: null, taxLife: null, categoryKey: 'widgets', assetNumber: 'ASST-0001' });
  });

  it('writes no asset row', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ max_num: 0 }] as never);
    await planAssetCreate(COMPANY, body);
    for (let i = 0; i < vi.mocked(sql).mock.calls.length; i++) expect(q(i)).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

describe('insertPlannedAsset / createAsset', () => {
  const plan = { categoryId: 'cat', sarsRate: 33.33, taxLife: 3, categoryKey: 'computers', assetNumber: 'COMP-0008' };

  it('inserts for the given company with the planned number, creator and defaults', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'new' }] as never);
    const row = await insertPlannedAsset(COMPANY, 'user-1', body, plan);
    expect(row).toEqual({ id: 'new' });
    expect(q(0)).toMatch(/INSERT INTO assets/);
    const p = params(0);
    expect(p[0]).toBe(COMPANY);
    expect(p).toContain('COMP-0008');
    expect(p).toContain('user-1');
    expect(p).toContain('available');
  });

  it('createAsset is plan then insert', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ max_num: 2 }] as never)
      .mockResolvedValueOnce([{ id: 'new', asset_number: 'COMP-0003' }] as never);
    const row = await createAsset(COMPANY, 'user-1', body);
    expect(row.asset_number).toBe('COMP-0003');
    expect(params(2)).toContain('COMP-0003');
  });
});

describe('listActiveAssetCategories / findSimilarAssets', () => {
  it('lists only active categories', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ code: 'computers', name: 'Computers', sars_years: '3' }] as never);
    expect(await listActiveAssetCategories()).toEqual([{ code: 'computers', name: 'Computers', sarsYears: 3 }]);
    expect(q(0)).toMatch(/is_active = true/);
  });

  it('finds similar assets inside the company only', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'x', asset_number: 'COMP-0001', name: 'Laptop' }] as never);
    expect(await findSimilarAssets(COMPANY, 'Laptop', '2026-03-02', 1000)).toEqual([
      { id: 'x', assetNumber: 'COMP-0001', name: 'Laptop' },
    ]);
    expect(q(0)).toMatch(/company_id = \?::UUID/);
    expect(params(0)[0]).toBe(COMPANY);
  });
});
