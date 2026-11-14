/**
 * assetDeleteService: scoping and locking of the SQL (the census itself runs against Postgres in
 * tests/integration/delete-fixed-asset.int.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { deleteLockedAsset, lockAndInspectAsset } from '@/modules/accounting/services/items/assetDeleteService';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const ASSET = 'a1a1a1a1-0000-4000-8000-000000000001';
const q = (i: number) => (vi.mocked(sql).mock.calls[i]![0] as unknown as string[]).join('?');
const params = (i: number) => vi.mocked(sql).mock.calls[i]!.slice(1);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('lockAndInspectAsset', () => {
  it('locks the company\'s row FOR UPDATE and reads nothing else when it is absent', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    expect(await lockAndInspectAsset(COMPANY, ASSET)).toBeNull();
    expect(q(0)).toMatch(/FOR UPDATE/);
    expect(q(0)).toMatch(/company_id = \?::UUID/);
    expect(params(0)).toEqual([ASSET, COMPANY]);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('a clean asset has no blockers; every census query is scoped to the company', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{
        asset_number: 'COMP-0001', name: 'Laptop', status: 'available', disposal_date: null, accumulated_depreciation: '0.00',
        tax_accumulated_depreciation: '0.00', tax_opening_acc_dep: '0.00', last_depreciation_date: null, below_threshold: false,
      }] as never)
      .mockResolvedValueOnce([{ period_ledger: 0, dep_schedule: 0, disposals: 0, fuel: 0, service: 0, bank_links: 0, journals: 0 }] as never);
    const out = await lockAndInspectAsset(COMPANY, ASSET);
    expect(out).toMatchObject({ assetNumber: 'COMP-0001', blockers: [] });
    expect(q(1)).toMatch(/gl_journal_entries\s+WHERE company_id = \?::UUID/);
    expect(params(1)).toContain('DEP-COMP-0001-');
    expect(params(1)).toContain('DIS-COMP-0001-');
    expect(params(1)).toContain('EXP-COMP-0001-');
  });
});

describe('deleteLockedAsset', () => {
  it('deletes by id AND company', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: ASSET }] as never);
    await deleteLockedAsset(COMPANY, ASSET);
    expect(q(0)).toMatch(/DELETE FROM assets WHERE id = \?::UUID AND company_id = \?::UUID/);
    expect(params(0)).toEqual([ASSET, COMPANY]);
  });

  it('throws when the row was not there to delete (never reports a delete that did not happen)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    await expect(deleteLockedAsset(COMPANY, ASSET)).rejects.toThrow(/was not deleted/);
  });
});
