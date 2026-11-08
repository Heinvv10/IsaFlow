/**
 * VAT201 field drill-down: each field's rows tie to its amount, in hand-written cents.
 * Only the data sources are stubbed (the period's journal lines, the nil-rated rows
 * and their totals); the expected figures are written out below, not derived from
 * getVat201Report or any service that shares the drill's helpers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LateClaimAwareLine } from '@/modules/accounting/services/reports/vatLateClaimBasis';

const state = vi.hoisted(() => ({ lines: [] as unknown[], nil: [] as unknown[] }));
vi.mock('@/modules/accounting/services/reports/vatBoxBasisQuery', () => ({
  getVatPeriodLines: vi.fn(async () => ({ lines: state.lines, postedThrough: '2026-06-30T00:00:00.000Z' })),
}));
vi.mock('@/modules/accounting/services/reports/vat201NilRatedSupplies', () => ({
  getNilRatedSupplies: vi.fn(async () => ({
    zeroRated: 500, exported: 200, exempt: 100, onTaxedJournals: 0, onTaxedCapital: 0, onTaxedAmbiguous: 0, uncodedAssumedZeroRated: 0,
  })),
}));
vi.mock('@/modules/accounting/services/reports/vat201NilRatedDrill', () => ({
  listNilRatedLines: vi.fn(async () => state.nil),
}));

import { vat201FieldDrill } from '@/modules/accounting/services/reports/vat201FieldDrill';

let n = 0;
function leg(entry: string, num: string, subtype: string | null, type: string, debit: number, credit: number,
  vatType: string | null, extra: Partial<LateClaimAwareLine> = {}): LateClaimAwareLine {
  n += 1;
  return {
    journalEntryId: entry, entryNumber: num, entryDate: '2026-06-15', lineId: `l${String(n).padStart(3, '0')}`,
    accountId: `a-${subtype ?? type}`, accountCode: `C-${subtype ?? type}`, accountName: `N-${subtype ?? type}`,
    accountType: type, accountSubtype: subtype, vatType, debit, credit, cancelledSource: false, ...extra,
  };
}

function fixture(): LateClaimAwareLine[] {
  n = 0;
  return [
    // J1 standard sale: base 1000.00, output tax 150.00
    leg('j1', 'J1', 'sales', 'revenue', 0, 1000, 'standard'),
    leg('j1', 'J1', 'vat_output', 'liability', 0, 150, 'standard'),
    leg('j1', 'J1', 'receivable', 'asset', 1150, 0, null),
    // J2 capital goods sale: base 2000.00, output tax 300.00
    leg('j2', 'J2', 'sales', 'revenue', 0, 2000, 'capital_goods'),
    leg('j2', 'J2', 'vat_output', 'liability', 0, 300, 'capital_goods'),
    leg('j2', 'J2', 'receivable', 'asset', 2300, 0, null),
    // J3 standard purchase: base 400.00, input tax 60.00
    leg('j3', 'J3', null, 'expense', 400, 0, 'standard'),
    leg('j3', 'J3', 'vat_input', 'asset', 60, 0, 'standard'),
    leg('j3', 'J3', 'payable', 'liability', 0, 460, null),
    // J4 imported goods: input tax 15.00 (box 14A/15A)
    leg('j4', 'J4', null, 'expense', 100, 0, 'imported'),
    leg('j4', 'J4', 'vat_input', 'asset', 15, 0, 'imported'),
    leg('j4', 'J4', 'payable', 'liability', 0, 115, null),
    // J5 output tax under a code no box maps: field 12 only, as a residual, 30.00
    leg('j5', 'J5', 'vat_output', 'liability', 0, 30, 'mystery'),
    // J6 input tax under a code no box maps: field 18 only, as a residual, 5.00
    leg('j6', 'J6', 'vat_input', 'asset', 5, 0, 'mystery'),
    // J7 raised by a cancelled document: its 999.00 is in no field
    leg('j7', 'J7', 'vat_output', 'liability', 0, 999, 'standard', { cancelledSource: true }),
  ];
}

const drill = (field: string, page = 1, pageSize = 100) => vat201FieldDrill('co-a', '2026-06-01', '2026-06-30', field, page, pageSize);

describe('vat201FieldDrill', () => {
  beforeEach(() => { state.lines = fixture(); state.nil = []; });

  it.each([
    ['4', 150, ['J1']], ['4A', 300, ['J2']], ['12', 30, ['J5']],
    ['15', 60, ['J3']], ['15A', 15, ['J4']], ['18', 5, ['J6']],
  ])('field %s: rows add up to %d', async (field, amount, entries) => {
    const r = await drill(field);
    expect(r).toMatchObject({ source: 'tax-lines', amount, rowsTotal: amount, ties: true });
    expect(r && 'rows' in r ? r.rows.map((x) => x.entryNumber) : []).toEqual(entries);
  });

  it('empty fields tie at zero (14, 17)', async () => {
    for (const f of ['14', '17']) expect(await drill(f)).toMatchObject({ source: 'tax-lines', amount: 0, rowsTotal: 0, ties: true, rowCount: 0 });
  });

  it('labels the residual legs of 12 and 18, and not the legs of their own box', async () => {
    const r12 = await drill('12');
    expect(r12 && 'rows' in r12 && r12.rows[0]).toMatchObject({ box: 'unclassified', residual: true, tax: 30 });
  });

  it('field 1 is the supply value (1,150.00): its legs are the box-1 tax, with the journal base beside', async () => {
    const r = await drill('1');
    expect(r).toMatchObject({ source: 'tax-lines', amount: 1150, rowsTotal: 150, ties: null });
    expect(r && 'rows' in r && r.rows[0]).toMatchObject({ entryNumber: 'J1', tax: 150, journalBase: 1000 });
  });

  it('a cancelled document\'s tax is in no field', async () => {
    for (const f of ['4', '12']) {
      const r = await drill(f);
      expect(r && 'rows' in r ? r.rows.some((x) => x.entryNumber === 'J7') : true).toBe(false);
    }
  });

  it('13, 19 and 20 return their components, and the components add to the field', async () => {
    const r13 = await drill('13');
    expect(r13).toMatchObject({ source: 'components', amount: 480, sum: 480 });
    expect(r13 && 'components' in r13 && r13.components.map((c) => [c.field, c.amount]))
      .toEqual([['4', 150], ['4A', 300], ['9', null], ['11', null], ['12', 30]]);
    expect(await drill('19')).toMatchObject({ source: 'components', amount: 80, sum: 80 });
    expect(await drill('20')).toMatchObject({ source: 'components', amount: 400, sum: 400 });
  });

  it('fields with no source say so rather than showing zero', async () => {
    for (const f of ['5', '10', '11', '14A', '16']) expect(await drill(f)).toMatchObject({ source: 'none', amount: null });
  });

  it('nil-rated fields list their revenue lines and tie to the field', async () => {
    state.nil = [
      { lineId: 'n1', journalEntryId: 'x1', entryNumber: 'X1', entryDate: '2026-06-02', accountCode: '4100', accountName: 'Exports', vatType: 'zero_rated', amount: 300 },
    ];
    expect(await drill('2')).toMatchObject({ source: 'nil-rated', amount: 300, rowsTotal: 300, ties: true });
    state.nil = [{ lineId: 'n2', journalEntryId: 'x2', entryNumber: 'X2', entryDate: '2026-06-03', accountCode: '4100', accountName: 'Exports', vatType: 'export', amount: 150 }];
    expect(await drill('2A')).toMatchObject({ amount: 200, rowsTotal: 150, ties: false });
  });

  it('pages at most 200 rows and says whether more follow', async () => {
    state.lines = [];
    for (let i = 0; i < 250; i++) state.lines.push(leg(`p${i}`, `P${String(i).padStart(3, '0')}`, 'vat_output', 'liability', 0, 1, 'standard'));
    const first = await drill('4', 1, 5000);
    expect(first).toMatchObject({ pageSize: 200, rowCount: 250, hasMore: true, rowsTotal: 250 });
    expect(first && 'rows' in first && first.rows).toHaveLength(200);
    const second = await drill('4', 2, 5000);
    expect(second && 'rows' in second && second.rows).toHaveLength(50);
    expect(second).toMatchObject({ hasMore: false });
  });

  it('an unknown field is not a field', async () => {
    expect(await drill('99')).toBeNull();
  });
});
