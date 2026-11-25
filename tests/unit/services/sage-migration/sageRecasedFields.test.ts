/**
 * Round-11 breaker B11-5 / B11-4: a field this import reads, spelled in another case, is refused, never ignored (Linetype 1 linked an
 * account line to an item, ItemID dropped the link, category / taxTypeIdSales were dropped); LineType "" is refused like "  ".
 * Cases from the breaker's b11-c-shapes.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';

const item = (id: number, extra: Record<string, unknown> = {}) => ({ ID: id, Code: `C${id}`, Description: 'a', Active: true, Physical: true, ...extra });
const po = (line: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ ID: 1, DocumentNumber: 'P1', Date: '2026-02-01', Status: 'Pending', SupplierId: 3,
  Exclusive: 100, Tax: 15, Total: 115, Lines: [{ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, ...line }], ...extra });
const refusal = (file: Record<string, unknown>) => {
  const p = parseSageExport(file);
  return { kept: p.items.length + p.purchaseOrders.length, codes: p.refusals.map((r) => r.code), why: p.refusals.flatMap((r) => r.reasons).join(' | ') };
};

describe('B11-5: a known field in another case', () => {
  it('on a PO line (Linetype, lineType, ItemID, selectionid) refuses the PO, never links or drops silently', () => {
    for (const [line, key, field] of [
      [{ Linetype: 1, SelectionId: 50 }, 'Linetype', 'LineType'], [{ lineType: 1, ItemId: 50 }, 'lineType', 'LineType'],
      [{ ItemID: 50 }, 'ItemID', 'ItemId'], [{ selectionid: 50 }, 'selectionid', 'SelectionId'], [{ taxtypeid: 2 }, 'taxtypeid', 'TaxTypeId'],
    ] as const) {
      const r = refusal({ Items: [item(50)], PurchaseOrders: [po(line)] });
      expect(r.kept, key).toBe(1); // the item only: the PO is refused
      expect(r.why, key).toContain(`Lines[0].${key} is ${field} in another case`);
    }
  });
  it('on an item row (category, taxTypeIdSales, physical) refuses the item', () => {
    for (const [extra, key, field] of [
      [{ category: { ID: 5, Description: 'Optics' } }, 'category', 'Category'], [{ taxTypeIdSales: 99 }, 'taxTypeIdSales', 'TaxTypeIdSales'], [{ PHYSICAL: false }, 'PHYSICAL', 'Physical'],
    ] as const) {
      const r = refusal({ Items: [item(1, extra)] });
      expect(r.kept, key).toBe(0);
      expect(r.codes, key).toEqual(['invalid_row']);
      expect(r.why, key).toContain(`${key} is ${field} in another case`);
    }
  });
  it('on a PO row (supplierid, Deliverydate) refuses the PO', () => {
    for (const [extra, key] of [[{ supplierid: 4 }, 'supplierid'], [{ Deliverydate: '2026-03-01' }, 'Deliverydate']] as const) {
      expect(refusal({ PurchaseOrders: [po({}, extra)] }).why, key).toContain(`${key} is `);
    }
  });
  it('fields this import does not read, in any case, stay ignored; the exact spelling reads', () => {
    expect(refusal({ Items: [item(1, { priceinclusive: 1, created: 'x', Modified: 'y' })], PurchaseOrders: [po({ total: 115 })] }).codes).toEqual([]);
    expect(parseSageExport({ Items: [item(50)], PurchaseOrders: [po({ ItemId: 50 })] }).purchaseOrders[0]!.lines[0]!.itemId).toBe('50');
  });
});

describe('B11-4: LineType ""', () => {
  it('is refused like "  " (an unknown line type), not read as an item line', () => {
    for (const t of ['', '  ']) {
      const r = refusal({ Items: [item(50)], PurchaseOrders: [po({ LineType: t, ItemId: 50 })] });
      expect(r.codes, JSON.stringify(t)).toEqual(['po_line_type_unknown']);
      expect(r.why).toContain(`LineType ${JSON.stringify(t)} is not 0 (item) or 1 (account)`);
    }
  });
  it('absent, null and 0 are still an item line', () => {
    for (const t of [undefined, null, 0, '0']) {
      expect(parseSageExport({ Items: [item(50)], PurchaseOrders: [po({ LineType: t, ItemId: 50 })] }).purchaseOrders[0]!.lines[0]!.itemId, String(t)).toBe('50');
    }
  });
});
