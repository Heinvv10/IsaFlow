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

import { deriveVatBoxesWithLateClaims } from '@/modules/accounting/services/reports/vatLateClaimBasis';
import { roundToTotal, vat201FieldDrill } from '@/modules/accounting/services/reports/vat201FieldDrill';

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
    // L1 late claim (source auto_vat_late_claim): input tax 45.00 on a recorded base of 300.00, in field 15
    leg('l1', 'L1', 'vat_input', 'asset', 45, 0, 'standard', { entrySource: 'auto_vat_late_claim', lateClaimBase: 300 }),
    leg('l1', 'L1', 'vat_input_late_claim', 'liability', 0, 45, null, { entrySource: 'auto_vat_late_claim' }),
    // M1 one purchase, two VAT types: base 1000.00, tax 90.00 standard (15) + 60.00 capital goods (14)
    leg('m1', 'M1', null, 'expense', 1000, 0, 'standard'),
    leg('m1', 'M1', 'vat_input', 'asset', 90, 0, 'standard'),
    leg('m1', 'M1', 'vat_input', 'asset', 60, 0, 'capital_goods'),
    leg('m1', 'M1', 'payable', 'liability', 0, 1150, null),
    // K1 coded-base rule: two expense lines, one coded standard (500.00), one uncoded (200.00): the tax is on 500.00
    leg('k1', 'K1', null, 'expense', 500, 0, 'standard'),
    leg('k1', 'K1', null, 'expense', 200, 0, null),
    leg('k1', 'K1', 'vat_input', 'asset', 75, 0, 'standard'),
    leg('k1', 'K1', 'payable', 'liability', 0, 775, null),
    // N1 input tax coded no_vat, 8.00: box 18 by name (not a residual)
    leg('n1', 'N1', 'vat_input', 'asset', 8, 0, 'no_vat'),
    // J7 raised by a cancelled document: its 999.00 is in no field
    leg('j7', 'J7', 'vat_output', 'liability', 0, 999, 'standard', { cancelledSource: true }),
  ];
}

const drill = (field: string, page = 1, pageSize = 100) => vat201FieldDrill('co-a', '2026-06-01', '2026-06-30', field, page, pageSize);

describe('vat201FieldDrill', () => {
  beforeEach(() => { state.lines = fixture(); state.nil = []; });

  it.each([
    ['4', 150, ['J1']], ['4A', 300, ['J2']], ['12', 30, ['J5']],
    ['15', 270, ['J3', 'K1', 'L1', 'M1']], ['14', 60, ['M1']], ['15A', 15, ['J4']], ['18', 13, ['J6', 'N1']],
  ])('field %s: rows add up to %d', async (field, amount, entries) => {
    const r = await drill(field);
    expect(r).toMatchObject({ source: 'tax-lines', amount, rowsTotal: amount, ties: true });
    expect(r && 'rows' in r ? r.rows.map((x) => x.entryNumber) : []).toEqual(entries);
  });

  it('an empty field ties at zero (17)', async () => {
    for (const f of ['17']) expect(await drill(f)).toMatchObject({ source: 'tax-lines', amount: 0, rowsTotal: 0, ties: true, rowCount: 0 });
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

  it('apportions a journal\'s base across its tax legs, so a multi-VAT journal is never double-counted', async () => {
    const r14 = await drill('14'); const r15 = await drill('15');
    const m14 = r14 && 'rows' in r14 ? r14.rows[0]!.journalBase : -1;
    const m15 = r15 && 'rows' in r15 ? r15.rows.find((x) => x.entryNumber === 'M1')!.journalBase : -1;
    expect([m14, m15]).toEqual([400, 600]);
  });

  it('tie: the rows\' journalBase add up to the base the box derivation attributes, per direction and per journal', async () => {
    const sumBase = async (fields: string[]) => {
      const out: Record<string, number> = {};
      for (const f of fields) {
        const r = await drill(f);
        if (r && 'rows' in r) for (const x of r.rows) out[x.entryNumber] = Math.round(((out[x.entryNumber] ?? 0) + x.journalBase) * 100) / 100;
      }
      return out;
    };
    // Hand-written: output J1 1000 + J2 2000; input J3 400, J4 100, K1 500 (coded-base rule: not 700), L1 300 (late claim), M1 1000.
    expect(await sumBase(['4', '4A', '12'])).toEqual({ J1: 1000, J2: 2000, J5: 0 });
    expect(await sumBase(['14', '15', '15A', '17', '18'])).toEqual({ J3: 400, J4: 100, K1: 500, L1: 300, M1: 1000, J6: 0, N1: 0 });
    // And the report's own totals say the same.
    const basis = deriveVatBoxesWithLateClaims(state.lines as LateClaimAwareLine[]);
    expect([basis.outputBase, basis.inputBase]).toEqual([3000, 2300]);
  });

  it('allocates a journal\'s cents exactly across legs of one type (three legs, base 100.00, equal tax)', async () => {
    state.lines = [
      leg('q1', 'Q1', null, 'expense', 100, 0, 'standard'),
      leg('q1', 'Q1', 'vat_input', 'asset', 5, 0, 'standard'), leg('q1', 'Q1', 'vat_input', 'asset', 5, 0, 'standard'),
      leg('q1', 'Q1', 'vat_input', 'asset', 5, 0, 'standard'),
    ];
    const r = await drill('15');
    const parts = r && 'rows' in r ? r.rows.map((x) => x.journalBase) : [];
    expect(Math.round(parts.reduce((a, b) => a + b, 0) * 100)).toBe(10000);
  });

  it('a late claim shows the base recorded on its own line; a no_vat leg is in 18 without the residual label', async () => {
    const r15 = await drill('15');
    expect(r15 && 'rows' in r15 && r15.rows.find((x) => x.entryNumber === 'L1')).toMatchObject({ tax: 45, journalBase: 300 });
    const r18 = await drill('18');
    expect(r18 && 'rows' in r18 && r18.rows.map((x) => [x.entryNumber, x.residual])).toEqual([['J6', true], ['N1', false]]);
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
    expect(await drill('19')).toMatchObject({ source: 'components', amount: 358, sum: 358 });
    expect(await drill('20')).toMatchObject({ source: 'components', amount: 122, sum: 122 });
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

  it('many journals: the rows of a box add up to the report\'s box base to the cent', async () => {
    // 40 journals of varying base (100.01 + 0.13i) over tax 3.00 standard + 7.00 capital: 30/70 shares. The box
    // rounds journal by journal as it accumulates and lands 1c off the sum of per-row roundings.
    state.lines = [];
    for (let i = 0; i < 40; i++) {
      const base = Math.round((100.01 + 0.13 * i) * 100) / 100;
      const e = `y${i}`; const num = `Y${String(i).padStart(3, '0')}`;
      state.lines.push(leg(e, num, null, 'expense', base, 0, 'standard'),
        leg(e, num, 'vat_input', 'asset', 3, 0, 'standard'), leg(e, num, 'vat_input', 'asset', 7, 0, 'capital_goods'),
        leg(e, num, 'payable', 'liability', 0, base + 10, null));
    }
    const basis = deriveVatBoxesWithLateClaims(state.lines as LateClaimAwareLine[]);
    for (const [field, type] of [['15', 'standard'], ['14', 'capital_goods']] as const) {
      const r = await drill(field, 1, 200);
      const rows = r && 'rows' in r ? r.rows : [];
      const sum = Math.round(rows.reduce((t, x) => t + Math.round(x.journalBase * 100), 0));
      const box = basis.boxes.find((b) => b.direction === 'input' && b.vatType === type)!;
      expect(rows).toHaveLength(40);
      expect(sum, field).toBe(Math.round(box.base * 100));
    }
  });

  it('credit notes (negative base and tax) allocate and tie like any journal', async () => {
    state.lines = [
      leg('c1', 'C1', 'sales', 'revenue', 0, 1000, 'standard'), leg('c1', 'C1', 'vat_output', 'liability', 0, 150, 'standard'),
      leg('c2', 'C2', 'sales', 'revenue', 400, 0, 'standard'), leg('c2', 'C2', 'vat_output', 'liability', 60, 0, 'standard'),
    ];
    const r = await drill('4');
    expect(r).toMatchObject({ amount: 90, rowsTotal: 90, ties: true });
    expect(r && 'rows' in r && r.rows.map((x) => [x.entryNumber, x.tax, x.journalBase])).toEqual([['C1', 150, 1000], ['C2', -60, -400]]);
  });

  it('an invoice and its full credit note in one box: box nets to zero, each row keeps its own base', async () => {
    state.lines = [
      leg('c1', 'C1', 'sales', 'revenue', 0, 1000, 'standard'), leg('c1', 'C1', 'vat_output', 'liability', 0, 150, 'standard'),
      leg('c2', 'C2', 'sales', 'revenue', 1000, 0, 'standard'), leg('c2', 'C2', 'vat_output', 'liability', 150, 0, 'standard'),
    ];
    const r = await drill('4');
    expect(r).toMatchObject({ amount: 0, rowsTotal: 0, ties: true });
    expect(r && 'rows' in r && r.rows.map((x) => [x.entryNumber, x.tax, x.journalBase])).toEqual([['C1', 150, 1000], ['C2', -150, -1000]]);
  });
});

describe('roundToTotal (round each share, hand out the leftover cents)', () => {
  it('rounds each share and hands leftover cents to the shares rounding moved furthest the other way, ties to the earlier index', () => {
    expect(roundToTotal(10, [10 / 3, 10 / 3, 10 / 3])).toEqual([4, 3, 3]);
    expect(roundToTotal(1, [0.5, 0.5])).toEqual([0, 1]);
    expect(roundToTotal(100, [33.4, 66.6])).toEqual([33, 67]);
    expect(roundToTotal(101, [33.4, 66.6])).toEqual([34, 67]);
    expect(roundToTotal(99, [33.4, 66.6])).toEqual([33, 66]);
  });
  it('a total that nets to zero keeps its mixed-sign shares rather than flattening them', () => {
    expect(roundToTotal(0, [100000, -100000])).toEqual([100000, -100000]);
  });
  it('a near-zero total a cent off its shares moves one cent, never scales the shares', () => {
    expect(roundToTotal(2, [100000, -99999])).toEqual([100001, -99999]);
    expect(roundToTotal(0, [100000, -99999])).toEqual([99999, -99999]);
  });
  it('no shares or zero shares still sum to the total', () => {
    expect(roundToTotal(10, [0, 0, 0])).toEqual([4, 3, 3]);
    expect(roundToTotal(0, [0, 0])).toEqual([0, 0]);
    expect(roundToTotal(0, [])).toEqual([]);
    expect(roundToTotal(1000, [1, 1])).toEqual([500, 500]);
    expect(() => roundToTotal(10, [Number.NaN])).toThrow(/finite/);
  });
  it('negative totals and shares still sum exactly', () => {
    expect(roundToTotal(-100, [-33.4, -66.6])).toEqual([-33, -67]);
    expect(roundToTotal(-10, [-10 / 3, -10 / 3, -10 / 3]).reduce((a, b) => a + b, 0)).toBe(-10);
  });
});
