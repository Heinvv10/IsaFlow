/**
 * Round-13 breaker B13-1 and the money-field refinement: what a PO line is BOOKED at must be Sage's own figure, or the PO is refused.
 *   - a line Tax or Total with no Exclusive is refused (the tool would book quantity x price, dropping Sage's figure);
 *   - Exclusive and Total without Tax: Total must be Exclusive + the tax the tool computes (lineCents);
 *   - fields that can be CHECKED are read and pass when they agree: a line's UnitPriceInclusive (UnitPriceExclusive at the line's rate),
 *     the header's SubTotal (= Exclusive) and AmountDue (= Total: a PO with payments against it is not imported).
 * Cases from the breaker's b13-money.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { mapSagePurchaseOrder } from '@/modules/accounting/services/sage-migration/sagePurchaseOrderMapping';
import { parsePurchaseOrder } from '@/lib/mcp/tools/purchaseOrderImportArgs';

type R = Record<string, unknown>;
const po = (lines: R[], hdr: R = {}) => ({ ID: 7, DocumentNumber: 'P7', Date: '2026-02-01', Status: 'Pending', SupplierId: 3, Exclusive: 100, Tax: 15, Total: 115, Lines: lines, ...hdr });
const L = (x: R = {}): R => ({ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, ...x });
const read = (row: R) => {
  const p = parseSageExport({ PurchaseOrders: [row] });
  return { ok: p.purchaseOrders.length === 1, codes: p.refusals.map((r) => r.code), why: p.refusals.flatMap((r) => r.reasons).join(' | '), parsed: p };
};
/** What the PO tool would book (its own parser), for a row the migration accepts. */
const booked = (row: R) => {
  const p = read(row);
  const t = parsePurchaseOrder(mapSagePurchaseOrder(p.parsed.purchaseOrders[0]!, '00000000-0000-4000-8000-000000000001', {}), 0);
  if (typeof t === 'string') throw new Error(t);
  return t.lines.map((l) => (l.cents.net + l.cents.tax) / 100);
};

describe('B13-1: a line Tax or Total without its Exclusive', () => {
  it('offsetting line Totals with no Exclusive (B13-A4) are refused, never booked at 115 / 115', () => {
    const r = read(po([L({ Total: 105 }), L({ Total: 125 })], { Exclusive: 200, Tax: 30, Total: 230 }));
    expect(r.ok).toBe(false);
    expect(r.why).toContain('Lines[0].Total is given without Exclusive');
    expect(r.why).toContain('Lines[1].Total is given without Exclusive');
  });
  it('a line Tax with no Exclusive is refused (it was dropped silently)', () => {
    expect(read(po([L({ Tax: 10 }), L({ Tax: 20 })], { Exclusive: 200, Tax: 30, Total: 230 })).why).toContain('Lines[0].Tax is given without Exclusive');
  });
  it('a line with no Exclusive, Tax or Total reads as before (quantity x price)', () => {
    expect(read(po([L()])).ok).toBe(true);
    expect(booked(po([L()]))).toEqual([115]);
  });
});

describe('Exclusive, Tax and Total', () => {
  it('Total must be their sum', () => {
    expect(read(po([L({ Exclusive: 100, Tax: 15, Total: 115 })])).ok).toBe(true);
    expect(read(po([L({ Exclusive: 100, Tax: 15, Total: 105 })])).why).toContain('Lines[0].Total 105 is not Exclusive 100 + Tax 15');
  });
});

describe('B13-1: Exclusive and Total, no Tax', () => {
  it('Total must be Exclusive + the tax the tool computes at the line rate', () => {
    const r = read(po([L({ Exclusive: 100, Total: 57.5 })]));
    expect(r.ok).toBe(false);
    expect(r.why).toContain('Lines[0].Total 57.5 is not Exclusive 100 + its tax at 15% (115)');
    expect(read(po([L({ Exclusive: 100, Total: 115 })])).ok).toBe(true);
    expect(booked(po([L({ Exclusive: 100, Total: 115 })]))).toEqual([115]);
  });
  it('a zero-rated line: Total equals Exclusive', () => {
    expect(read(po([L({ TaxTypeId: 2, Exclusive: 100, Total: 100 })], { Tax: 0, Total: 100 })).ok).toBe(true);
    expect(read(po([L({ TaxTypeId: 2, Exclusive: 100, Total: 115 })], { Tax: 0, Total: 100 })).why).toMatch(/Total 115 is not Exclusive 100 \+ its tax at 0% \(100\)/);
  });
});

describe('checkable fields are read, and refuse only when they disagree', () => {
  it('a line UnitPriceInclusive that agrees with UnitPriceExclusive at the line rate passes; one that does not is refused', () => {
    expect(read(po([L({ UnitPriceInclusive: 115 })])).ok).toBe(true);
    const r = read(po([L({ UnitPriceInclusive: 110 })]));
    expect(r.ok).toBe(false);
    expect(r.why).toContain('Lines[0].UnitPriceInclusive 110 is not UnitPriceExclusive 100 at 15% (115)');
  });
  it('a header SubTotal must be Exclusive', () => {
    expect(read(po([L()], { SubTotal: 100 })).ok).toBe(true);
    expect(read(po([L()], { SubTotal: 90 })).why).toContain('SubTotal 90 is not Exclusive 100');
  });
  it('a header AmountDue must be Total: anything else (payments against the PO) is refused as unsupported', () => {
    expect(read(po([L()], { AmountDue: 115 })).ok).toBe(true);
    const r = read(po([L()], { AmountDue: 15 }));
    expect(r.codes).toEqual(['po_money_field_unsupported']);
    expect(r.why).toContain('AmountDue 15 is not Total 115: a PO with payments or credits against it is not imported');
  });
  it('they must be numbers', () => {
    expect(read(po([L()], { SubTotal: '100' })).why).toContain('SubTotal must be a number');
  });
});
