/**
 * Edit / delete of the CC1 / CC2 master: the ladder rules hold on edit as they
 * do on create, and a project never moves to another FNO under lines that
 * already store the old one.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/modules/accounting/services/core/dimensionMasterLock', () => ({ lockDimensionMasters: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionMasterService', () => ({ listDimensionCostCentres: vi.fn() }));
vi.mock('@/modules/accounting/services/core/costCentreUsageGuard', () => ({
  countCc2Carriers: vi.fn(async () => 0), assertCostCentreUnused: vi.fn(async () => undefined),
  costCentreDefaultUsage: vi.fn(async () => ''),
}));
vi.mock('@/modules/accounting/services/core/costCentreService', () => ({ deleteCostCentre: vi.fn() }));

import { sql } from '@/lib/neon';
import { listDimensionCostCentres, type DimensionCostCentre } from '@/modules/accounting/services/gl/dimensions/dimensionMasterService';
import { assertCostCentreUnused, costCentreDefaultUsage, countCc2Carriers } from '@/modules/accounting/services/core/costCentreUsageGuard';
import { lockDimensionMasters } from '@/modules/accounting/services/core/dimensionMasterLock';
import { deleteCostCentre } from '@/modules/accounting/services/core/costCentreService';
import {
  applyDeleteDimensionCostCentre, applyUpdateDimensionCostCentre, planDeleteDimensionCostCentre, planUpdateDimensionCostCentre,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const C = 'company-1';

function cc(over: Partial<DimensionCostCentre> & Pick<DimensionCostCentre, 'id' | 'code'>): DimensionCostCentre {
  return {
    name: over.code, ccType: 'cc2', isActive: true, parentId: null, parentCode: null, fnoCode: null,
    aliases: [], description: null, department: null, ...over,
  };
}

// FT001 > FT-LAW ; HT001 > HT-PHA (programme) > HT-PHA-BNF
const MASTER: DimensionCostCentre[] = [
  cc({ id: 'ft', code: 'FT001', ccType: 'cc1', fnoCode: 'FT001', aliases: ['FibreTime'] }),
  cc({ id: 'ht', code: 'HT001', ccType: 'cc1', fnoCode: 'HT001' }),
  cc({ id: 'law', code: 'FT-LAW', parentId: 'ft', parentCode: 'FT001', fnoCode: 'FT001', aliases: ['Lawley'] }),
  cc({ id: 'pha', code: 'HT-PHA', parentId: 'ht', parentCode: 'HT001', fnoCode: 'HT001' }),
  cc({ id: 'bnf', code: 'HT-PHA-BNF', parentId: 'pha', parentCode: 'HT-PHA', fnoCode: 'HT001', aliases: ['Ben Farms'] }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDimensionCostCentres).mockResolvedValue(MASTER.map((m) => ({ ...m, aliases: [...m.aliases] })));
  vi.mocked(countCc2Carriers).mockResolvedValue(0);
  vi.mocked(costCentreDefaultUsage).mockResolvedValue('');
});

describe('planUpdateDimensionCostCentre — refusals (reads only)', () => {
  it.each([
    ['an unknown cost centre', 'NOPE', {}, /does not exist/],
    ['a code that is another centre\'s code', 'FT-LAW', { code: 'ht001' }, /already the code or an alias of HT001/],
    ['a code that is another centre\'s alias', 'FT-LAW', { code: 'Ben Farms' }, /alias of HT-PHA-BNF/],
    ['a parent on a CC1', 'FT001', { parent: 'HT001' }, /takes no parent/],
    ['a parent loop (descendant)', 'HT-PHA', { parent: 'HT-PHA-BNF' }, /make a loop/],
    ['itself as parent', 'FT-LAW', { parent: 'Lawley' }, /make a loop/],
    ['an alias used elsewhere', 'FT-LAW', { addAliases: ['fibretime'] }, /alias of FT001/],
    ['removing an alias it does not have', 'FT-LAW', { removeAliases: ['Mohadin'] }, /no alias "Mohadin"/],
    ['deactivating a node with active children', 'HT-PHA', { isActive: false }, /active children \(HT-PHA-BNF\)/],
    ['an over-long department', 'FT-LAW', { department: 'x'.repeat(101) }, /department is at most 100/],
  ])('refuses %s', async (_l, ref, input, msg) => {
    await expect(planUpdateDimensionCostCentre(C, ref, input)).rejects.toThrow(msg);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('refuses an inactive parent and reactivating under an inactive parent', async () => {
    vi.mocked(listDimensionCostCentres).mockResolvedValue(MASTER.map((m) => (m.id === 'ht' ? { ...m, isActive: false } : m)));
    await expect(planUpdateDimensionCostCentre(C, 'FT-LAW', { parent: 'HT001' })).rejects.toThrow(/active CC1 or CC2/);
    vi.mocked(listDimensionCostCentres).mockResolvedValue(MASTER.map((m) => (
      m.id === 'ht' ? { ...m, isActive: false } : m.id === 'pha' ? { ...m, isActive: false } : m)));
    await expect(planUpdateDimensionCostCentre(C, 'HT-PHA', { isActive: true })).rejects.toThrow(/sits under inactive HT001/);
  });

  it('refuses moving a carried project (or its subtree) to another FNO, counting the whole subtree', async () => {
    vi.mocked(countCc2Carriers).mockResolvedValueOnce(12);
    await expect(planUpdateDimensionCostCentre(C, 'HT-PHA', { parent: 'FT001' }))
      .rejects.toThrow(/from FNO HT001 to FT001 would leave the CC1 wrong on 12/);
    expect(countCc2Carriers).toHaveBeenCalledWith(C, ['pha', 'bnf']);
  });
});

describe('planUpdateDimensionCostCentre — allowed edits', () => {
  it('moves an uncarried project and derives the new FNO', async () => {
    const plan = await planUpdateDimensionCostCentre(C, 'FT-LAW', { parent: 'HT-PHA' });
    expect(plan.after).toMatchObject({ parentId: 'pha', parentCode: 'HT-PHA', fnoCode: 'HT001' });
    expect(plan.changed).toEqual(['parent']);
  });

  it('does not count carriers when the FNO stays the same (re-parent within one FNO)', async () => {
    await planUpdateDimensionCostCentre(C, 'HT-PHA-BNF', { parent: 'HT001' });
    expect(countCc2Carriers).not.toHaveBeenCalled();
  });

  it('renames a CC1 code (ids on lines are untouched) and re-derives its own FNO code', async () => {
    const plan = await planUpdateDimensionCostCentre(C, 'FT001', { code: 'FT' });
    expect(plan.after).toMatchObject({ code: 'FT', fnoCode: 'FT' });
  });

  it('replaces, adds and removes aliases by normalised key', async () => {
    const replaced = await planUpdateDimensionCostCentre(C, 'FT-LAW', { aliases: ['LAWLEY', 'Lawley Ext'] });
    expect(replaced.addAliases.map((a) => a.alias)).toEqual(['Lawley Ext']);
    expect(replaced.removeAliasKeys).toEqual([]);
    const removed = await planUpdateDimensionCostCentre(C, 'FT-LAW', { removeAliases: ['lawley'] });
    expect(removed.removeAliasKeys).toEqual(['lawley']);
  });

  it('warns when a project is detached and no FNO can be derived', async () => {
    const plan = await planUpdateDimensionCostCentre(C, 'FT-LAW', { parent: null });
    expect(plan.after.fnoCode).toBeNull();
    expect(plan.warnings[0]).toMatch(/no FNO/);
  });
});

describe('apply / delete', () => {
  it('writes the row, then the alias removals and additions', async () => {
    const plan = await planUpdateDimensionCostCentre(C, 'FT-LAW', { name: 'Lawley Ext 1', aliases: ['Lawley X'] });
    await applyUpdateDimensionCostCentre(C, plan, 'user-1');
    const texts = mockSql.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(texts[0]).toMatch(/UPDATE cost_centres SET/);
    expect(texts[1]).toMatch(/DELETE FROM cost_centre_aliases/);
    expect(texts[2]).toMatch(/INSERT INTO cost_centre_aliases/);
  });

  it('delete runs the counted usage guard first and refuses through it', async () => {
    vi.mocked(assertCostCentreUnused).mockRejectedValueOnce(new Error('Cannot delete cost centre that is used by 3 journal line(s). Deactivate instead.'));
    await expect(planDeleteDimensionCostCentre(C, 'Lawley')).rejects.toThrow(/3 journal line/);
    const target = await planDeleteDimensionCostCentre(C, 'Lawley');
    expect(assertCostCentreUnused).toHaveBeenLastCalledWith(C, 'law');
    await applyDeleteDimensionCostCentre(C, target, 'user-1');
    expect(deleteCostCentre).toHaveBeenCalledWith(C, 'law');
  });
});

describe('#678 review', () => {
  it('takes the master lock before its first read, on every plan (M1)', async () => {
    const order: string[] = [];
    vi.mocked(lockDimensionMasters).mockImplementation(async () => { order.push('lock'); });
    vi.mocked(listDimensionCostCentres).mockImplementation(async () => { order.push('read'); return MASTER; });
    await planUpdateDimensionCostCentre(C, 'FT-LAW', { name: 'x' });
    await planDeleteDimensionCostCentre(C, 'FT-LAW');
    expect(order).toEqual(['lock', 'read', 'lock', 'read']);
    expect(lockDimensionMasters).toHaveBeenCalledWith(C);
  });

  it('an edit that changes nothing plans an empty change set and apply writes nothing (M4)', async () => {
    const plan = await planUpdateDimensionCostCentre(C, 'FT-LAW', { name: 'FT-LAW', isActive: true });
    expect(plan.changed).toEqual([]);
    await applyUpdateDimensionCostCentre(C, plan, 'user-1');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('keeps an unchanged parent that is inactive or reaches no FNO, and checks only a new one (M3)', async () => {
    vi.mocked(listDimensionCostCentres).mockResolvedValue(MASTER.map((m) => (
      m.id === 'ht' || m.id === 'pha' || m.id === 'bnf' ? { ...m, isActive: false, ...(m.id !== 'ht' ? { fnoCode: null } : {}) } : m)));
    const kept = await planUpdateDimensionCostCentre(C, 'HT-PHA-BNF', { parent: 'pha', name: 'Ben' });
    expect(kept.after).toMatchObject({ parentId: 'pha', name: 'Ben' });
    expect(kept.changed).toEqual(['name']);
    await expect(planUpdateDimensionCostCentre(C, 'FT-LAW', { parent: 'pha' })).rejects.toThrow(/active CC1 or CC2/);
  });

  it('edits an active node under an inactive parent without reactivation checks (M3)', async () => {
    vi.mocked(listDimensionCostCentres).mockResolvedValue(MASTER.map((m) => (m.id === 'ft' ? { ...m, isActive: false } : m)));
    const plan = await planUpdateDimensionCostCentre(C, 'FT-LAW', { name: 'Lawley 2' });
    expect(plan.changed).toEqual(['name']);
  });

  it('refuses deactivating a centre a default names, with the counts (L3)', async () => {
    vi.mocked(costCentreDefaultUsage).mockResolvedValueOnce('2 customer(s), 1 account(s)');
    await expect(planUpdateDimensionCostCentre(C, 'FT-LAW', { isActive: false }))
      .rejects.toThrow('FT-LAW is the default on 2 customer(s), 1 account(s) — clear those defaults before deactivating it');
    expect(costCentreDefaultUsage).toHaveBeenCalledWith(C, 'law');
  });

  it('refuses a code matching more than one centre ignoring case — even with an exact match — and checks a case-only rename (L2)', async () => {
    vi.mocked(listDimensionCostCentres).mockResolvedValue([...MASTER, cc({ id: 'law2', code: 'ft-law', parentId: 'ft', fnoCode: 'FT001' })]);
    await expect(planUpdateDimensionCostCentre(C, 'ft-law', { name: 'n' })).rejects.toThrow(/matches 2 cost centres .* send its id, or its cc_type/);
    await expect(planUpdateDimensionCostCentre(C, 'Ft-Law', { name: 'n' })).rejects.toThrow(/matches 2 cost centres/);
    expect((await planUpdateDimensionCostCentre(C, 'law2', { name: 'n' })).before.id).toBe('law2');
    await expect(planUpdateDimensionCostCentre(C, 'law2', { code: 'FT-LAW' })).rejects.toThrow(/already the code or an alias of FT-LAW/);
  });

  it('refuses a code shared across cc_type, and the cc_type picks one (#683 round 2)', async () => {
    vi.mocked(listDimensionCostCentres).mockResolvedValue([...MASTER, cc({ id: 'abc1', code: 'ABC', ccType: 'cc1', fnoCode: 'ABC' }),
      cc({ id: 'abc2', code: 'abc', parentId: 'ft', fnoCode: 'FT001' })]);
    await expect(planUpdateDimensionCostCentre(C, 'ABC', { name: 'n' })).rejects.toThrow('"ABC" matches 2 cost centres (ABC cc1, abc cc2) — send its id, or its cc_type');
    await expect(planDeleteDimensionCostCentre(C, 'abc')).rejects.toThrow(/matches 2 cost centres/);
    expect((await planUpdateDimensionCostCentre(C, 'ABC', { name: 'n' }, 'cc2')).before.id).toBe('abc2');
    expect((await planDeleteDimensionCostCentre(C, 'abc', 'cc1')).id).toBe('abc1');
    // A parent named by such a code is refused too — and told to send the parent's id: cc_type narrows the
    // centre being edited, not its parent (#683 round 3).
    await expect(planUpdateDimensionCostCentre(C, 'FT-LAW', { parent: 'Abc' }, 'cc2'))
      .rejects.toThrow('parent "Abc" matches 2 cost centres (ABC cc1, abc cc2) — send the parent\'s id');
    expect((await planUpdateDimensionCostCentre(C, 'FT-LAW', { parent: 'abc2' })).after.parentId).toBe('abc2');
  });

  it('a 23505 inside apply comes out as a refusal (L1)', async () => {
    const plan = await planUpdateDimensionCostCentre(C, 'FT-LAW', { addAliases: ['New'] });
    mockSql.mockResolvedValueOnce([]).mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(applyUpdateDimensionCostCentre(C, plan, 'u')).rejects.toMatchObject({ code: 'DIMENSION_REFUSED', message: /just taken/ });
  });
});
