/** Round 5 (B5-MED): what a re-run compares of a PO already in the books beyond what the PO tool does (supplier, delivery date, reference, lines). PURE. */
import { describe, expect, it } from 'vitest';
import { poContentDifferences, withContentDifferences, type PoContent } from '@/modules/accounting/services/sage-migration/sagePoContent';

const S1 = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const S2 = '1a7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f7';
// What the plan holds of a PO: the tool's own parse of the element (purchaseOrderImportArgs), i.e. what the tool would STORE.
const element = (over: Record<string, unknown> = {}) => ({
  supplierId: S1, deliveryDate: '2026-03-01', reference: 'JOB-1',
  lines: [
    { description: 'Fibre drop cable', quantity: 2, unitPrice: 1200, itemCode: null },
    { description: 'Delivery charge', quantity: 1, unitPrice: 350.5, itemCode: null },
  ], ...over,
});
const stored = (over: Partial<PoContent> = {}): PoContent => ({
  supplierId: S1, deliveryDate: '2026-03-01', reference: 'JOB-1',
  lines: [{ description: 'Fibre drop cable', quantity: 2, unitPrice: 1200 }, { description: 'Delivery charge', quantity: 1, unitPrice: 350.5 }], ...over,
});
const plan = (el: Record<string, unknown> = element(), supplierProblem?: string) => ({ purchaseOrders: [{ sageId: '1', documentNumber: 'PO1', stored: el as never, supplierProblem }] });
const diff = (el: Record<string, unknown>, st: PoContent | undefined) => poContentDifferences(plan(el), new Map(st ? [['1', st]] : []));

describe('poContentDifferences', () => {
  it('a PO that matches in every compared field has no difference; a PO not in the books has none to compare', () => {
    expect(diff(element(), stored())).toEqual([]);
    expect(diff(element(), undefined)).toEqual([]);
  });
  it('lists a moved supplier, with both ids', () => {
    expect(diff(element({ supplierId: S2 }), stored())).toEqual([{ poNumber: 'PO1', differences: [{ field: 'supplier', existing: S1, requested: S2 }] }]);
  });
  it('lists a changed delivery date and a changed reference, and a date or reference Sage no longer has', () => {
    const d = diff(element({ deliveryDate: '2026-03-31', reference: 'JOB-999' }), stored())[0]!.differences;
    expect(d).toEqual([{ field: 'delivery_date', existing: '2026-03-01', requested: '2026-03-31' }, { field: 'reference', existing: 'JOB-1', requested: 'JOB-999' }]);
    const dropped = diff(element({ deliveryDate: null, reference: null }), stored())[0]!.differences;
    expect(dropped.map((x) => [x.field, x.existing, x.requested])).toEqual([['delivery_date', '2026-03-01', null], ['reference', 'JOB-1', null]]);
  });
  it('a stored PO with none where Sage has one differs the same way', () => {
    expect(diff(element(), stored({ deliveryDate: null, reference: null }))[0]!.differences.map((x) => x.field)).toEqual(['delivery_date', 'reference']);
  });
  it('lists a line whose quantity, unit price or description changed at the same total, by its position', () => {
    const el = element({ lines: [{ description: 'Fibre drop cable', quantity: 4, unitPrice: 600 }, { description: 'Delivery charge (half)', quantity: 1, unitPrice: 350.5 }] });
    expect(diff(el, stored())[0]!.differences).toEqual([
      { field: 'line 1 quantity', existing: 2, requested: 4 },
      { field: 'line 1 unit_price', existing: 1200, requested: 600 },
      { field: 'line 2 description', existing: 'Delivery charge', requested: 'Delivery charge (half)' },
    ]);
  });
  it('a line added or removed is one difference, the line count', () => {
    const el = element({ lines: [{ description: 'Fibre drop cable', quantity: 2, unitPrice: 1200, itemCode: null }] });
    expect(diff(el, stored())[0]!.differences).toEqual([{ field: 'lines', existing: 2, requested: 1 }]);
  });
  it('the " [item CODE]" suffix of an unlinked line is not a difference (the item may have been activated since)', () => {
    const line = (description: string) => ({ description, quantity: 2, unitPrice: 1200, itemCode: 'FIB-1' });
    const second = { description: 'Delivery charge', quantity: 1, unitPrice: 350.5, itemCode: null };
    const st = stored({ lines: [{ description: 'Fibre drop cable [item FIB-1]', quantity: 2, unitPrice: 1200 }, { description: 'Delivery charge', quantity: 1, unitPrice: 350.5 }] });
    expect(diff(element({ lines: [line('Fibre drop cable'), second] }), st)).toEqual([]);
    expect(diff(element({ lines: [line('Fibre drop cable [item FIB-1]'), second] }), stored())).toEqual([]);
  });
  it('B6-H (round 6): only the exact " [item CODE]" suffix is stripped, so a code with "]" in it is handled and a real change is not hidden', () => {
    const line = (description: string, itemCode: string | null) => ({ description, quantity: 1, unitPrice: 10, itemCode });
    const withCode = (d: string) => element({ lines: [line(d, 'FIB]0001')] });
    const st = (d: string) => stored({ lines: [{ description: d, quantity: 1, unitPrice: 10 }] });
    expect(diff(withCode('Cable'), st('Cable [item FIB]0001]'))).toEqual([]); // stored with the suffix, sent without (item activated since)
    expect(diff(withCode('Cable [item FIB]0001]'), st('Cable'))).toEqual([]);
    // a description that merely ends in a bracketed word is NOT a suffix: a changed description is still listed
    expect(diff(element({ lines: [line('Cable [item X]', null)] }), st('Cable'))[0]!.differences.map((d) => d.field)).toEqual(['line 1 description']);
    expect(diff(element({ lines: [line('Cable [item OTHER]', 'FIB-1')] }), st('Cable'))[0]!.differences.map((d) => d.field)).toEqual(['line 1 description']);
  });
  it('compares numbers as numbers: 2 and 2.00, 350.5 and 350.500000', () => {
    expect(diff(element(), stored({ lines: [{ description: 'Fibre drop cable', quantity: Number('2.00'), unitPrice: Number('1200.000000') }, { description: 'Delivery charge', quantity: 1, unitPrice: Number('350.500000') }] }))).toEqual([]);
  });
});

describe('M2 (round 7): a supplier the plan could not resolve for a booked PO is a difference', () => {
  it('listed under supplier, existing = the booked supplier, requested = what the plan says; the other fields still compare', () => {
    const problem = 'Sage supplier 301 "Alpha" not found in IsaFlow; PO is booked to Alpha Renamed (' + S1 + ')';
    const d = poContentDifferences(plan(element({ reference: 'JOB-2' }), problem), new Map([['1', stored()]]));
    expect(d).toEqual([{ poNumber: 'PO1', differences: [
      { field: 'supplier', existing: S1, requested: problem },
      { field: 'reference', existing: 'JOB-1', requested: 'JOB-2' },
    ] }]);
  });
  it('no problem, no extra difference', () => {
    expect(poContentDifferences(plan(element(), undefined), new Map([['1', stored()]]))).toEqual([]);
  });
});

describe('withContentDifferences', () => {
  const base = { purchaseOrders: [{ poNumber: 'PO1', differences: [{ field: 'total', existing: 1, requested: 2 }] }], items: [], categories: [] };
  it('adds a PO the tool did not name, and merges the fields of one it did (once per PO, the tool\'s first)', () => {
    const out = withContentDifferences(base, [{ poNumber: 'PO1', differences: [{ field: 'supplier', existing: 'a', requested: 'b' }] }, { poNumber: 'PO2', differences: [{ field: 'reference', existing: 'x', requested: 'y' }] }]);
    expect(out.purchaseOrders.map((p) => [p.poNumber, p.differences.map((d) => d.field)])).toEqual([['PO1', ['total', 'supplier']], ['PO2', ['reference']]]);
  });
  it('leaves the report alone when there is nothing to add', () => {
    expect(withContentDifferences(base, [])).toEqual(base);
  });
});
