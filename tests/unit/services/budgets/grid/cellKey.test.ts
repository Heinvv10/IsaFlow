/**
 * Cell keys: one string per (account, CC1, CC2, BU, month), round-tripping, and
 * the grain a cell sits at (decision 4).
 */
import { describe, it, expect } from 'vitest';
import { cellKey, grainOf, parseKey, rowKeyOf } from '@/modules/accounting/services/budgets/grid/cellKey';

const A = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

describe('cellKey / parseKey', () => {
  it('round-trips every grain', () => {
    const refs = [
      { glAccountId: A, cc1Id: null, cc2Id: null, buId: null, month: '2027-03' },
      { glAccountId: A, cc1Id: C, cc2Id: null, buId: null, month: '2027-03' },
      { glAccountId: A, cc1Id: null, cc2Id: C, buId: null, month: '2028-02' },
      { glAccountId: A, cc1Id: null, cc2Id: null, buId: B, month: '2027-12' },
      { glAccountId: A, cc1Id: C, cc2Id: null, buId: B, month: '2027-01' },
    ];
    for (const r of refs) expect(parseKey(cellKey(r))).toEqual(r);
  });

  it('is the documented shape', () => {
    expect(cellKey({ glAccountId: A, cc1Id: C, cc2Id: null, buId: null, month: '2027-03' })).toBe(`${A}|${C}|||2027-03`);
  });

  it('refuses a bad month or an id carrying the separator', () => {
    expect(() => cellKey({ glAccountId: A, cc1Id: null, cc2Id: null, buId: null, month: '2027-13' })).toThrow();
    expect(() => cellKey({ glAccountId: `${A}|x`, cc1Id: null, cc2Id: null, buId: null, month: '2027-01' })).toThrow();
    expect(() => parseKey('a|b|c')).toThrow();
  });

  it('rowKeyOf drops the month', () => {
    const k = cellKey({ glAccountId: A, cc1Id: null, cc2Id: null, buId: B, month: '2027-03' });
    expect(rowKeyOf(k)).toBe(`${A}|||${B}`);
  });
});

describe('grainOf', () => {
  it.each([
    [{ cc1Id: null, cc2Id: null, buId: null }, 'company'],
    [{ cc1Id: C, cc2Id: null, buId: null }, 'cc1'],
    [{ cc1Id: null, cc2Id: C, buId: null }, 'cc2'],
    [{ cc1Id: null, cc2Id: null, buId: B }, 'bu'],
    [{ cc1Id: C, cc2Id: null, buId: B }, 'multi'],
  ] as const)('%o → %s', (dims, grain) => {
    expect(grainOf({ glAccountId: A, month: '2027-03', ...dims })).toBe(grain);
  });
});
