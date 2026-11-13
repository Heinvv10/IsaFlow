/**
 * create_fixed_asset: registers an asset on the subledger and posts NOTHING.
 *
 * Pinned here: every refusal runs before the INSERT and the dry run runs them all (parity); the dry run writes
 * nothing and sets `wroteNothing` (the key stays free); the live call inserts exactly what the plan minted, scoped to
 * the token company; the insert has no catch; the tool needs write:journals and NOT write:post.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/items/assetCreateService', () => ({
  listActiveAssetCategories: vi.fn(),
  planAssetCreate: vi.fn(),
  insertPlannedAsset: vi.fn(),
  findSimilarAssets: vi.fn(),
}));

import {
  findSimilarAssets,
  insertPlannedAsset,
  listActiveAssetCategories,
  planAssetCreate,
} from '@/modules/accounting/services/items/assetCreateService';
import { createFixedAssetTool } from '@/lib/mcp/tools/writeCreateFixedAsset';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const ctx = { companyId: COMPANY, userId: 'u-1', tokenJti: 'jti' } as unknown as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const GOOD = {
  name: 'Dell Latitude 5440', category: 'computers', purchase_date: '2026-03-02', cost: 18500.5,
  useful_life_years: 3, ...KEY,
};
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const json = (r: { content: { text: string }[] }) => JSON.parse(text(r)) as Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listActiveAssetCategories).mockResolvedValue([
    { code: 'computers', name: 'Computers', sarsYears: 3 },
    { code: 'furniture', name: 'Furniture', sarsYears: 6 },
  ]);
  vi.mocked(planAssetCreate).mockResolvedValue({
    categoryId: 'cat-1', sarsRate: 33.33, taxLife: 3, categoryKey: 'computers', assetNumber: 'COMP-0004',
  });
  vi.mocked(findSimilarAssets).mockResolvedValue([]);
  vi.mocked(insertPlannedAsset).mockResolvedValue({
    id: 'a1a1a1a1-0000-4000-8000-000000000001', asset_number: 'COMP-0004', purchase_date: '2026-03-02',
  });
});

describe('create_fixed_asset: registration', () => {
  it('needs write:journals, is a write, and does not need write:post (it posts nothing)', () => {
    expect(createFixedAssetTool.scope).toBe('write:journals');
    expect(createFixedAssetTool.write).toBe(true);
    expect(createFixedAssetTool.requiresPost).toBeUndefined();
  });

  it('is registered, named to clients and free of Flow charges', () => {
    expect(MCP_TOOLS.some((t) => t.name === 'create_fixed_asset')).toBe(true);
    expect(CLIENT_MCP_TOOL_NAMES).toContain('create_fixed_asset');
    expect(flowOperationFor('create_fixed_asset')).toBeNull();
  });

  it('takes no company, account, dimension or status argument', () => {
    const props = Object.keys((createFixedAssetTool.inputSchema as { properties: object }).properties);
    for (const forbidden of ['company_id', 'gl_asset_account_id', 'cost_centre_id', 'status', 'password', 'token']) {
      expect(props).not.toContain(forbidden);
    }
  });

  it('inserts what the plan minted for the TOKEN company and user, and reports the id', async () => {
    const r = await createFixedAssetTool.handler(GOOD, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.wroteNothing).toBeUndefined();
    expect(planAssetCreate).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ category: 'computers', cost: 18500.5 }));
    expect(insertPlannedAsset).toHaveBeenCalledTimes(1);
    const [company, user, input, plan] = vi.mocked(insertPlannedAsset).mock.calls[0]!;
    expect([company, user]).toEqual([COMPANY, 'u-1']);
    expect(input).toMatchObject({
      name: 'Dell Latitude 5440', category: 'computers', sarsCategory: 'computers', purchaseDate: '2026-03-02',
      cost: 18500.5, salvageValue: 0, usefulLifeYears: 3, depreciationMethod: 'straight_line',
    });
    expect(plan.assetNumber).toBe('COMP-0004');
    const out = json(r);
    expect(out).toMatchObject({ asset_id: 'a1a1a1a1-0000-4000-8000-000000000001', asset_number: 'COMP-0004', posts_to_ledger: false });
    expect(String(out.reversal)).toMatch(/No MCP tool or app route deletes an asset/);
  });

  it('passes the optional fields through trimmed', async () => {
    await createFixedAssetTool.handler({
      ...GOOD, salvage_value: 500, depreciation_method: 'reducing_balance', description: ' 14 inch ',
      serial_number: 'SN1', location: 'Head office',
    }, ctx);
    expect(vi.mocked(insertPlannedAsset).mock.calls[0]![2]).toMatchObject({
      salvageValue: 500, depreciationMethod: 'reducing_balance', description: '14 inch', serialNumber: 'SN1',
      location: 'Head office',
    });
  });

  it('reports an existing asset with the same name, date and cost, and still registers', async () => {
    vi.mocked(findSimilarAssets).mockResolvedValue([{ id: 'x', assetNumber: 'COMP-0003', name: 'Dell Latitude 5440' }]);
    const r = await createFixedAssetTool.handler(GOOD, ctx);
    expect(json(r).possible_duplicates).toEqual([{ id: 'x', assetNumber: 'COMP-0003', name: 'Dell Latitude 5440' }]);
    expect(insertPlannedAsset).toHaveBeenCalledTimes(1);
    expect(findSimilarAssets).toHaveBeenCalledWith(COMPANY, 'Dell Latitude 5440', '2026-03-02', 18500.5);
  });

  it('lets an insert failure propagate (a returned error would commit the savepoint)', async () => {
    vi.mocked(insertPlannedAsset).mockRejectedValue(new Error('boom'));
    await expect(createFixedAssetTool.handler(GOOD, ctx)).rejects.toThrow('boom');
  });
});

describe('create_fixed_asset: dry run', () => {
  it('returns the asset and number it would create, no journals, writes nothing and frees the key', async () => {
    const r = await createFixedAssetTool.handler({ ...GOOD, dry_run: true }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.wroteNothing).toBe(true);
    expect(insertPlannedAsset).not.toHaveBeenCalled();
    expect(json(r)).toMatchObject({
      dryRun: true, journals: [], journalsTotal: 0, posts_to_ledger: false,
      asset: { asset_number: 'COMP-0004', cost: 18500.5, status: 'available', sars_rate: 33.33, tax_useful_life_years: 3 },
    });
  });

  it('runs the same refusals as the live call, with the same message', async () => {
    const bad: Array<Record<string, unknown>> = [
      { name: '' }, { category: 'nonsense' }, { cost: 0 }, { cost: 10.005 }, { cost: 'x' }, { salvage_value: 99999 },
      { salvage_value: -1 }, { useful_life_years: 0 }, { useful_life_years: 1000 }, { useful_life_years: 2.555 },
      { depreciation_method: 'units' }, { purchase_date: '2999-01-01' }, { purchase_date: '2026-02-31' },
      { purchase_date: '1800-01-01' }, { purchase_date: undefined }, { name: 'a\u0000b' },
    ];
    for (const patch of bad) {
      const live = await createFixedAssetTool.handler({ ...GOOD, ...patch }, ctx);
      const dry = await createFixedAssetTool.handler({ ...GOOD, ...patch, dry_run: true }, ctx);
      expect(live.isError, JSON.stringify(patch)).toBe(true);
      expect(dry.isError, JSON.stringify(patch)).toBe(true);
      expect(text(dry)).toBe(text(live));
    }
    expect(insertPlannedAsset).not.toHaveBeenCalled();
  });

  it('a dry run then a live call with the same key both succeed (the preview did not consume it)', async () => {
    const dry = await createFixedAssetTool.handler({ ...GOOD, dry_run: true }, ctx);
    const live = await createFixedAssetTool.handler(GOOD, ctx);
    expect(dry.wroteNothing).toBe(true);
    expect(live.isError).toBeUndefined();
    expect(insertPlannedAsset).toHaveBeenCalledTimes(1);
  });
});

describe('create_fixed_asset: refusals happen before any write', () => {
  it('an unknown category lists the valid codes and neither plans nor inserts', async () => {
    const r = await createFixedAssetTool.handler({ ...GOOD, category: 'spaceships' }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('computers, furniture');
    expect(planAssetCreate).not.toHaveBeenCalled();
    expect(insertPlannedAsset).not.toHaveBeenCalled();
  });

  it('an inactive category is unknown (only active categories are offered)', async () => {
    vi.mocked(listActiveAssetCategories).mockResolvedValue([{ code: 'furniture', name: 'Furniture', sarsYears: 6 }]);
    const r = await createFixedAssetTool.handler(GOOD, ctx);
    expect(r.isError).toBe(true);
    expect(insertPlannedAsset).not.toHaveBeenCalled();
  });

  it.each([
    ['empty name', { name: '  ' }, /name/i],
    ['zero cost', { cost: 0 }, /cost/i],
    ['three-decimal cost', { cost: 1.001 }, /cents/],
    ['salvage above cost', { salvage_value: 20000 }, /Salvage/],
    ['zero life', { useful_life_years: 0 }, /life/i],
    ['bad method', { depreciation_method: 'units' }, /depreciation_method/],
    ['future date', { purchase_date: '2999-12-31' }, /future/],
    ['impossible date', { purchase_date: '2026-02-31' }, /purchase_date/],
    ['NUL byte', { location: 'a\u0000b' }, /NUL/],
  ])('refuses %s with a message naming the field and inserts nothing', async (_n, patch, re) => {
    const r = await createFixedAssetTool.handler({ ...GOOD, ...patch }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(re);
    expect(insertPlannedAsset).not.toHaveBeenCalled();
    expect(listActiveAssetCategories).not.toHaveBeenCalled();
  });
});
