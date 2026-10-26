/**
 * Dimension pivot (spec §11, decision 4): an account is edited only at its own
 * grain; other views show it read-only with a reason. Invariant 2: the company
 * roll-up equals the sum of the dimension lines.
 */
import { describe, it, expect } from 'vitest';
import { type CellRef, cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import {
  type PivotInput, type View, accountGrains, memberTotals, resolveView, viewCellKey,
} from '@/modules/accounting/services/budgets/grid/pivot';

const MONTHS = ['2027-03', '2027-04', '2027-05'];
const [NONE, CO, CC1, CC2, BU, MIXED] = ['acc-none', 'acc-co', 'acc-cc1', 'acc-cc2', 'acc-bu', 'acc-mixed'];
const [M1, M2] = ['cc-m1', 'cc-m2'];

const cell = (glAccountId: string, month: string, dims: Partial<Pick<CellRef, 'cc1Id' | 'cc2Id' | 'buId'>> = {}) =>
  cellKey({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, ...dims });

const cells = new Map<string, number | null>([
  [cell(CO, '2027-03'), 1000],
  [cell(CO, '2027-04'), 0],
  [cell(CC1, '2027-03', { cc1Id: M1 }), 100],
  [cell(CC1, '2027-03', { cc1Id: M2 }), 250],
  [cell(CC1, '2027-04', { cc1Id: M2 }), -50],
  [cell(CC2, '2027-05', { cc2Id: M1 }), 70],
  [cell(BU, '2027-03', { buId: 'bu-1' }), 5],
  [cell(MIXED, '2027-03'), 1],
  [cell(MIXED, '2027-03', { cc1Id: M1, buId: 'bu-1' }), 2],
  // A cleared (pending delete) cell does not give the account a grain.
  [cell(NONE, '2027-03', { cc1Id: M1 }), null],
]);
const input: PivotInput = { accountIds: [NONE, CO, CC1, CC2, BU, MIXED], months: MONTHS, cells };
const company: View = { kind: 'company' };
const byCc1 = (memberId: string): View => ({ kind: 'cc1', memberId });

describe('accountGrains', () => {
  it('derives each account grain from its non-null cells', () => {
    expect(Object.fromEntries(accountGrains(cells))).toEqual({
      [CO]: 'company', [CC1]: 'cc1', [CC2]: 'cc2', [BU]: 'bu', [MIXED]: 'mixed',
    });
  });
});

describe('resolveView: Company', () => {
  const v = resolveView(input, company);

  it('none and company grain are editable at company level', () => {
    expect(v.get(NONE)).toEqual({ values: [null, null, null], editable: true });
    expect(v.get(CO)).toEqual({ values: [1000, 0, null], editable: true });
  });

  it('a CC1-grain account is a read-only roll-up of its members', () => {
    expect(v.get(CC1)).toEqual({ values: [350, -50, null], editable: false, readReason: 'Roll-up of CC1, switch view to edit' });
  });

  it('cc2 / bu grain are read-only roll-ups; a mixed grain says edit via Excel', () => {
    expect(v.get(CC2)).toMatchObject({ values: [null, null, 70], editable: false });
    expect(v.get(BU)).toMatchObject({ values: [5, null, null], editable: false });
    expect(v.get(MIXED)).toMatchObject({ values: [3, null, null], editable: false, readReason: expect.stringMatching(/Excel/) });
  });
});

describe('resolveView: By CC1', () => {
  const v = resolveView(input, byCc1(M2));

  it('none grain is editable (it becomes CC1 grain on the first write)', () => {
    expect(v.get(NONE)).toEqual({ values: [null, null, null], editable: true });
  });

  it('a CC1-grain account is editable for the chosen member only', () => {
    expect(v.get(CC1)).toEqual({ values: [250, -50, null], editable: true });
    expect(resolveView(input, byCc1(M1)).get(CC1)).toEqual({ values: [100, null, null], editable: true });
  });

  it('company grain and other dimensions are read-only with a reason', () => {
    expect(v.get(CO)).toEqual({ values: [null, null, null], editable: false, readReason: 'Budgeted at company level' });
    expect(v.get(CC2)).toMatchObject({ editable: false, readReason: 'Budgeted by CC2' });
    expect(v.get(BU)).toMatchObject({ editable: false, readReason: 'Budgeted by BU' });
    expect(v.get(MIXED)).toMatchObject({ editable: false, readReason: expect.stringMatching(/Excel/) });
  });
});

describe('locked and read-only access', () => {
  it('a locked version is read-only everywhere, values unchanged', () => {
    const v = resolveView({ ...input, locked: true }, company);
    expect(v.get(CO)).toEqual({ values: [1000, 0, null], editable: false, readReason: 'Locked version' });
  });

  it('a user without write access cannot edit', () => {
    expect(resolveView({ ...input, canWrite: false }, company).get(CO)).toMatchObject({ editable: false, readReason: 'Read-only access' });
  });
});

describe('invariant 2: company roll-up = Σ dimension lines', () => {
  it.each([CC1, CC2])('%s', acc => {
    const kind = acc === CC1 ? 'cc1' : 'cc2';
    const roll = resolveView(input, company).get(acc)!.values;
    const sum = MONTHS.map((_, m) => [M1, M2].reduce<number | null>((s, id) => {
      const x = resolveView(input, { kind, memberId: id }).get(acc)!.values[m];
      return x === null ? s : (s ?? 0) + x;
    }, null));
    expect(roll).toEqual(sum);
  });
});

describe('viewCellKey / memberTotals', () => {
  it('writes land at the view grain', () => {
    expect(viewCellKey(CO, company, '2027-03')).toBe(cell(CO, '2027-03'));
    expect(viewCellKey(CC1, byCc1(M1), '2027-04')).toBe(cell(CC1, '2027-04', { cc1Id: M1 }));
    expect(viewCellKey(BU, { kind: 'bu', memberId: 'b' }, '2027-05')).toBe(cell(BU, '2027-05', { buId: 'b' }));
  });

  it('member totals are signed by the account band (income +, expense −)', () => {
    const sign = (id: string) => (id === CC1 ? 1 : -1);
    // M1: CC1's 100, less the mixed (expense) account's CC1×BU cell of 2.
    expect(Object.fromEntries(memberTotals(cells, 'cc1', sign))).toEqual({ [M1]: 98, [M2]: 200 });
  });
});
