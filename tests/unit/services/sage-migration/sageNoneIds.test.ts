/**
 * Round-10 review L4 and breaker B10-3c: which fields carry the "unknown whether Sage means none" reason.
 *   - only the fields where Sage may write 0 or "" for none: ItemId, SelectionId, TaxTypeId / TaxTypeIdSales / TaxTypeIdPurchases and
 *     Category. A row's own ID 0, SupplierId 0 get a plain invalid-id reason (no "none" there: the row needs one);
 *   - '' (or blanks) in those fields is the same open question as 0: refused with that reason, never read as absent;
 *   - a Category Description of '' and of blanks get the same reason.
 */
import { describe, expect, it } from 'vitest';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';

const NONE = /unknown whether Sage means none/;
const item = (id: number, extra: Record<string, unknown> = {}) => ({ ID: id, Code: `C${id}`, Description: 'a', Active: true, Physical: true, ...extra });
const po = (line: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ ID: 1, DocumentNumber: 'P1', Date: '2026-02-01', Status: 'Pending', SupplierId: 3,
  Exclusive: 100, Tax: 15, Total: 115, Lines: [{ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, ...line }], ...extra });
const reasons = (file: Record<string, unknown>): string => parseSageExport(file).refusals.flatMap((r) => r.reasons).join(' | ');

describe('L4: the "none" reason is for the fields where Sage may mean none', () => {
  it('a row\'s own ID 0 and a SupplierId 0 get a plain invalid-id reason', () => {
    for (const file of [{ Items: [item(0)] }, { PurchaseOrders: [po({}, { ID: 0 })] }, { PurchaseOrders: [po({}, { SupplierId: 0 })] }, { PurchaseOrders: [po({}, { SupplierId: '00' })] }]) {
      const why = reasons(file);
      expect(why, JSON.stringify(file)).toMatch(/(ID|SupplierId) must be a Sage numeric id \(0 is not one\)/);
      expect(why, JSON.stringify(file)).not.toMatch(NONE);
    }
  });
  it('ItemId, SelectionId, TaxTypeId* and Category keep it', () => {
    for (const file of [
      { Items: [item(50)], PurchaseOrders: [po({ ItemId: 0 })] }, { Items: [item(50)], PurchaseOrders: [po({ SelectionId: '0' })] },
      { Items: [item(50)], PurchaseOrders: [po({ TaxTypeId: 0, TaxPercentage: 15 })] },
      { Items: [item(1, { TaxTypeIdSales: 0 })] }, { Items: [item(1, { TaxTypeIdPurchases: '00' })] }, { Items: [item(1, { Category: { ID: 0, Description: 'X' } })] },
    ]) expect(reasons(file), JSON.stringify(file)).toMatch(NONE);
  });
});

describe('B10-3c: an empty string in a "none" field is refused like 0, not read as absent', () => {
  it('ItemId "" is refused (it went unlinked and uncounted), with SelectionId beside it too', () => {
    for (const line of [{ ItemId: '' }, { ItemId: '  ' }, { ItemId: '', SelectionId: 50 }, { SelectionId: '' }]) {
      const p = parseSageExport({ Items: [item(50)], PurchaseOrders: [po(line)] });
      expect(p.purchaseOrders, JSON.stringify(line)).toHaveLength(0);
      expect(p.refusals.flatMap((r) => r.reasons).join(' | '), JSON.stringify(line)).toMatch(/Lines\[0\]\.(ItemId|SelectionId) is empty: .*unknown whether Sage means none/);
    }
  });
  it('TaxTypeIdSales "" and a line TaxTypeId "" are refused', () => {
    const items = parseSageExport({ Items: [item(1, { TaxTypeIdSales: '' })] });
    expect(items.items).toHaveLength(0);
    expect(reasons({ Items: [item(1, { TaxTypeIdSales: '' })] })).toMatch(/TaxTypeIdSales is empty: .*unknown whether Sage means none/);
    expect(parseSageExport({ Items: [item(50)], PurchaseOrders: [po({ TaxTypeId: '', TaxPercentage: 15 })] }).purchaseOrders).toHaveLength(0);
  });
  it('a Category ID "" gets the Category "none" reason', () => {
    expect(reasons({ Items: [item(1, { Category: { ID: '', Description: 'X' } })] })).toMatch(/^Category .*unknown whether Sage means none/);
  });
  it('absent and null stay absent (no field is no question)', () => {
    const p = parseSageExport({ Items: [item(50, { TaxTypeIdSales: null })], PurchaseOrders: [po({ ItemId: null })] });
    expect(p.refusals).toEqual([]);
    expect(p.purchaseOrders[0]!.lines[0]!.itemId).toBeNull();
  });
});

describe('L4: a Category Description of blanks reads as one of ""', () => {
  it('both get the "none" reason', () => {
    const empty = reasons({ Items: [item(1, { Category: { ID: 5, Description: '' } })] });
    const blank = reasons({ Items: [item(1, { Category: { ID: 5, Description: '   ' } })] });
    expect(empty).toMatch(NONE);
    expect(blank).toBe(empty);
  });
});
