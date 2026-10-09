/**
 * Edit / delete for the dimension masters: the BU service rules (clearing,
 * code clash, counted delete refusal) and the four MCP tools' contract —
 * dry_run writes nothing, refusals come back as tool errors.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/modules/accounting/services/core/dimensionMasterLock', () => ({ lockDimensionMasters: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionMasterEdit', () => ({
  planUpdateDimensionCostCentre: vi.fn(), applyUpdateDimensionCostCentre: vi.fn(),
  planDeleteDimensionCostCentre: vi.fn(), applyDeleteDimensionCostCentre: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  applyUpdateDimensionCostCentre, planDeleteDimensionCostCentre, planUpdateDimensionCostCentre, applyDeleteDimensionCostCentre,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import { DimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import {
  assertBusinessUnitUnused, deleteBusinessUnit, planUpdateBusinessUnit,
} from '@/modules/accounting/services/core/businessUnitService';
import {
  deleteBusinessUnitTool, deleteCostCentreTool, updateBusinessUnitTool, updateCostCentreTool,
} from '@/lib/mcp/tools/dimensionMasterEditTools';
import { createBusinessUnitTool } from '@/lib/mcp/tools/dimensionMasterTools';
import { planCreateBusinessUnit } from '@/modules/accounting/services/core/businessUnitService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const ctx = { companyId: 'company-1', userId: 'user-1', tokenJti: 'jti', oauthAppId: null, scopes: [] } as never;
const KEY = { idempotency_key: 'k' };
const BU_ID = '33333333-3333-4333-8333-333333333333';
const buRow = (over: Record<string, unknown> = {}) => ({
  id: BU_ID, code: 'BUILD', name: 'Build', description: null, division: null, is_active: true,
  created_at: 'x', updated_at: 'x', ...over,
});
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const sqlText = (i: number): string => (mockSql.mock.calls[i]![0] as string[]).join('?');

beforeEach(() => { vi.clearAllMocks(); mockSql.mockReset(); mockSql.mockResolvedValue([]); });

describe('planUpdateBusinessUnit', () => {
  it('sets a division, and an empty division clears it', async () => {
    mockSql.mockResolvedValueOnce([buRow()]);
    const set = await planUpdateBusinessUnit('company-1', 'build', { division: 'Build & Delivery' });
    expect(set.after.division).toBe('Build & Delivery');
    expect(set.changed).toEqual(['division']);
    mockSql.mockResolvedValueOnce([buRow({ division: 'Build & Delivery' })]);
    const cleared = await planUpdateBusinessUnit('company-1', BU_ID, { division: '' });
    expect(cleared.after.division).toBeNull();
  });

  it('refuses a code another BU already has; an edit that changes nothing plans no change', async () => {
    mockSql.mockResolvedValueOnce([buRow()]).mockResolvedValueOnce([{ code: 'MAINT' }]);
    await expect(planUpdateBusinessUnit('company-1', 'BUILD', { code: 'maint' })).rejects.toThrow(/code MAINT already exists/);
    mockSql.mockResolvedValueOnce([buRow()]);
    expect((await planUpdateBusinessUnit('company-1', 'BUILD', { name: 'Build' })).changed).toEqual([]);
  });

  it('checks a case-only rename for a clash (L2)', async () => {
    mockSql.mockResolvedValueOnce([buRow()]).mockResolvedValueOnce([{ code: 'build' }]);
    await expect(planUpdateBusinessUnit('company-1', BU_ID, { code: 'Build' })).rejects.toThrow(/code build already exists/);
  });

  it('refuses deactivating a BU an account names as its default (L3)', async () => {
    mockSql.mockResolvedValueOnce([buRow()]).mockResolvedValueOnce([{ accounts: 2 }]);
    await expect(planUpdateBusinessUnit('company-1', BU_ID, { isActive: false }))
      .rejects.toThrow('BUILD is the default on 2 account(s) — clear those defaults before deactivating it');
    expect(sqlText(1)).toMatch(/default_bu_id = \?::UUID AND company_id = \?::UUID/);
  });

  it('refuses an unknown BU', async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(planUpdateBusinessUnit('company-1', 'NOPE', { name: 'x' })).rejects.toThrow(/not found: NOPE/);
  });
});

describe('BU delete guard', () => {
  it('counts every carrier, including document lines, defaults and un-reversed tag batches', async () => {
    mockSql.mockResolvedValueOnce([{ journal_lines: 0, bank_transactions: 0, documents: 2, defaults: 1, tag_history: 4 }]);
    await expect(assertBusinessUnitUnused('company-1', BU_ID))
      .rejects.toThrow('Cannot delete business unit that is used by 2 document line(s), 1 account default(s), 4 un-reversed tag batch line(s). Deactivate instead.');
    expect(sqlText(0)).toMatch(/old_bu_id[\s\S]*reversed_at IS NULL/);
  });

  it('deletes an unused BU and reports one already gone', async () => {
    mockSql.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{ id: BU_ID }]);
    await expect(deleteBusinessUnit('company-1', BU_ID)).resolves.toBeUndefined();
    mockSql.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    await expect(deleteBusinessUnit('company-1', BU_ID)).rejects.toThrow(/not found/);
  });
});

describe('update_cost_centre / delete_cost_centre', () => {
  const plan = {
    before: { id: 'law', ccType: 'cc2' },
    after: { code: 'FT-LAW', name: 'Lawley', parentCode: 'HT-PHA', fnoCode: 'HT001', isActive: true },
    addAliases: [], removeAliasKeys: [], changed: ['parent'], warnings: [],
  };

  it('refuses aliases together with add_aliases before any lookup', async () => {
    const r = await updateCostCentreTool.handler({ cost_centre: 'FT-LAW', aliases: ['a'], add_aliases: ['b'], ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(planUpdateDimensionCostCentre).not.toHaveBeenCalled();
  });

  it('dry_run plans and writes nothing; live applies the plan', async () => {
    vi.mocked(planUpdateDimensionCostCentre).mockResolvedValue(plan as never);
    const dry = await updateCostCentreTool.handler({ cost_centre: 'FT-LAW', parent: 'HT-PHA', dry_run: true, ...KEY }, ctx);
    expect(dry.wroteNothing).toBe(true);
    expect(applyUpdateDimensionCostCentre).not.toHaveBeenCalled();
    expect(planUpdateDimensionCostCentre).toHaveBeenCalledWith('company-1', 'FT-LAW', expect.objectContaining({ parent: 'HT-PHA' }));
    const live = await updateCostCentreTool.handler({ cost_centre: 'FT-LAW', parent: 'HT-PHA', ...KEY }, ctx);
    expect(JSON.parse(text(live as never))).toMatchObject({ fno_code: 'HT001', changed: ['parent'] });
    expect(applyUpdateDimensionCostCentre).toHaveBeenCalledTimes(1);
  });

  it('passes parent: null through as "detach"', async () => {
    vi.mocked(planUpdateDimensionCostCentre).mockResolvedValue(plan as never);
    await updateCostCentreTool.handler({ cost_centre: 'FT-LAW', parent: null, dry_run: true, ...KEY }, ctx);
    expect(planUpdateDimensionCostCentre).toHaveBeenCalledWith('company-1', 'FT-LAW', expect.objectContaining({ parent: null }));
  });

  it('answers a refusal as a tool error and writes nothing', async () => {
    vi.mocked(planDeleteDimensionCostCentre).mockRejectedValueOnce(new DimensionRefusal('cost centre "X" does not exist in this company'));
    const r = await deleteCostCentreTool.handler({ cost_centre: 'X', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r as never)).toMatch(/does not exist/);
    expect(applyDeleteDimensionCostCentre).not.toHaveBeenCalled();
  });
});

describe('update_business_unit / delete_business_unit', () => {
  it('dry_run of a division change writes nothing', async () => {
    mockSql.mockResolvedValueOnce([buRow()]);
    const r = await updateBusinessUnitTool.handler({ business_unit: 'BUILD', division: 'Build & Delivery', dry_run: true, ...KEY }, ctx);
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(text(r as never))).toMatchObject({ division: 'Build & Delivery', changed: ['division'] });
    expect(mockSql.mock.calls.some((c) => /UPDATE business_units/.test((c[0] as string[]).join('?')))).toBe(false);
  });

  it('refuses a delete with the counts, before any DELETE', async () => {
    mockSql.mockResolvedValueOnce([buRow()]).mockResolvedValueOnce([{ journal_lines: 7 }]);
    const r = await deleteBusinessUnitTool.handler({ business_unit: 'BUILD', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r as never)).toMatch(/7 journal line\(s\)/);
    expect(mockSql.mock.calls.some((c) => /DELETE FROM business_units/.test((c[0] as string[]).join('?')))).toBe(false);
  });
});

describe('#678 review (MCP)', () => {
  const plan = {
    before: { id: 'law', ccType: 'cc2' },
    after: { code: 'FT-LAW', name: 'Lawley', parentCode: 'HT-PHA', fnoCode: 'HT001', isActive: true },
    addAliases: [], removeAliasKeys: [], changed: ['parent'], warnings: [],
  };

  it('update_cost_centre refuses an edit that changes nothing, before any apply', async () => {
    vi.mocked(planUpdateDimensionCostCentre).mockResolvedValue({ ...plan, changed: [] } as never);
    const r = await updateCostCentreTool.handler({ cost_centre: 'FT-LAW', name: 'Lawley', ...KEY }, ctx);
    expect(text(r as never)).toBe('Nothing to change');
    expect(applyUpdateDimensionCostCentre).not.toHaveBeenCalled();
  });

  it('update_cost_centre answers a refusal raised by the apply (a race-time 23505) as a tool error (L1)', async () => {
    vi.mocked(planUpdateDimensionCostCentre).mockResolvedValue(plan as never);
    vi.mocked(applyUpdateDimensionCostCentre).mockRejectedValueOnce(new DimensionRefusal('code FT-LAW or one of its aliases was just taken'));
    const r = await updateCostCentreTool.handler({ cost_centre: 'FT-LAW', parent: 'HT-PHA', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r as never)).toMatch(/just taken/);
  });

  it('update_cost_centre lets an unclassified failure in the apply propagate', async () => {
    vi.mocked(planUpdateDimensionCostCentre).mockResolvedValue(plan as never);
    vi.mocked(applyUpdateDimensionCostCentre).mockRejectedValueOnce(new Error('connection lost'));
    await expect(updateCostCentreTool.handler({ cost_centre: 'FT-LAW', parent: 'HT-PHA', ...KEY }, ctx)).rejects.toThrow('connection lost');
  });

  it('update_business_unit answers a race-time 23505 as the code refusal (L1)', async () => {
    mockSql.mockResolvedValueOnce([buRow()]).mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const r = await updateBusinessUnitTool.handler({ business_unit: BU_ID, code: 'MAINT', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r as never)).toBe('A business unit with code MAINT already exists');
  });

  it('update_business_unit refuses an edit that changes nothing', async () => {
    mockSql.mockResolvedValueOnce([buRow()]);
    const r = await updateBusinessUnitTool.handler({ business_unit: BU_ID, name: 'Build', ...KEY }, ctx);
    expect(text(r as never)).toBe('Nothing to change');
  });

  it('delete_business_unit answers an FK-held DELETE (23503) as the in-use refusal (L1)', async () => {
    mockSql.mockResolvedValueOnce([buRow()]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    const r = await deleteBusinessUnitTool.handler({ business_unit: BU_ID, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r as never)).toMatch(/Cannot delete business unit that is used by other records/);
  });

  it('findBusinessUnit refuses a reference matching two codes that differ only in case, prefers an exact one (L2)', async () => {
    mockSql.mockResolvedValueOnce([buRow({ code: 'BUILD' }), buRow({ id: 'x', code: 'build' })]);
    await expect(planUpdateBusinessUnit('company-1', 'Build', { name: 'x' })).rejects.toThrow(/differ only in case/);
    mockSql.mockResolvedValueOnce([buRow({ code: 'BUILD' }), buRow({ id: 'x', code: 'build' })]);
    expect((await planUpdateBusinessUnit('company-1', 'build', { name: 'x' })).before.id).toBe('x');
  });
});

describe('BU create validation lives in the service (L7)', () => {
  it.each([
    [{ code: ' ', name: 'Ops' }, 'code is required and at most 20 characters'],
    [{ code: 'X'.repeat(21), name: 'Ops' }, 'code is required and at most 20 characters'],
    [{ code: 'OPS', name: 'N'.repeat(256) }, 'name is required and at most 255 characters'],
    [{ code: 'OPS', name: 'Ops', division: 'D'.repeat(121) }, 'division is at most 120 characters'],
  ])('refuses %j before any read', async (input, msg) => {
    await expect(planCreateBusinessUnit('company-1', input)).rejects.toThrow(msg);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('refuses a code another BU has ignoring case, and trims what it keeps', async () => {
    mockSql.mockResolvedValueOnce([{ code: 'OPS' }]);
    await expect(planCreateBusinessUnit('company-1', { code: ' ops ', name: 'Ops' })).rejects.toThrow('A business unit with code OPS already exists');
    expect(sqlText(0)).toMatch(/lower\(code\) = \?/);
    expect(mockSql.mock.calls[0]!.slice(1)).toContain('ops');
    mockSql.mockResolvedValueOnce([]);
    expect(await planCreateBusinessUnit('company-1', { code: ' ops ', name: ' Ops ', division: ' ', description: ' d ' }))
      .toEqual({ code: 'ops', name: 'Ops', division: undefined, description: 'd' });
  });

  it('create_business_unit answers the service refusal, even on dry_run, and writes nothing', async () => {
    mockSql.mockResolvedValueOnce([{ code: 'OPS' }]);
    const r = await createBusinessUnitTool.handler({ code: 'ops', name: 'Ops', dry_run: true, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r as never)).toBe('A business unit with code OPS already exists');
    expect(mockSql.mock.calls.some((c) => /INSERT INTO business_units/.test((c[0] as string[]).join('?')))).toBe(false);
  });
});
