/**
 * The Sage export parser: the synthetic fixture reads clean, and every rule that refuses a row refuses it with a reason.
 * Each `it` pins one rule (the mutation table in the PR names the line that breaks it).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport, rowsOf, SageExportShapeError } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { parseSageItem } from '@/modules/accounting/services/sage-migration/sageItemParser';
import { parseSagePurchaseOrder } from '@/modules/accounting/services/sage-migration/sagePurchaseOrderParser';

type Row = Record<string, unknown>;
const fixture = (): { Items: { $resources: Row[] }; PurchaseOrders: Row[] } =>
  JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'));
const item = (over: Row = {}): Row => ({ ...fixture().Items.$resources[0], ...over });
const po = (over: Row = {}): Row => ({ ...fixture().PurchaseOrders[0], ...over });
const reasons = (r: ReturnType<typeof parseSageItem>) => (r.ok ? [] : r.refusal.reasons);
/** The row is refused AND one of its reasons matches: a bare `!ok` would pass for any fault. */
const refusedFor = (r: ReturnType<typeof parseSageItem> | ReturnType<typeof parseSagePurchaseOrder>): string =>
  (r.ok ? 'NOT REFUSED' : r.refusal.reasons.join(' | '));

describe('the synthetic fixture', () => {
  it('reads clean: 20 items in 4 categories, 10 purchase orders, no refusal', () => {
    const p = parseSageExport(fixture());
    expect(p.refusals).toEqual([]);
    expect(p.items).toHaveLength(20);
    expect(p.categories.map((c) => c.description).sort()).toEqual(['Optics', 'Poles and Hardware', 'Services', 'Tools']);
    expect(p.purchaseOrders).toHaveLength(10);
    expect(p.rowsIn).toEqual({ items: 20, purchaseOrders: 10 });
    expect(p.items.filter((i) => !i.physical)).toHaveLength(4);
    expect(p.items.filter((i) => !i.active)).toHaveLength(2);
  });

  it('counts the PO total over every PO row, and the QuantityOnHand rows it ignores', () => {
    const f = fixture();
    const p = parseSageExport(f);
    expect(p.exportPoTotalCents).toBe(f.PurchaseOrders.reduce((s, r) => s + Math.round((r.Total as number) * 100), 0));
    expect(p.itemsWithQuantityOnHand).toBe(20);
  });

  it('a typed item has no quantity field at all (QuantityOnHand cannot reach a mapping)', () => {
    const p = parseSageExport(fixture());
    for (const i of p.items) expect(Object.keys(i).filter((k) => /quant|stock|opening/i.test(k))).toEqual([]); // not even a flag (R16-F5)
    expect(JSON.stringify(p.items)).not.toMatch(/"quantity/i);
  });
});

describe('F4: an empty or partial export is refused as a whole', () => {
  const shape = (f: unknown) => { try { parseSageExport(f); return 'accepted'; } catch (e) { return e instanceof SageExportShapeError ? e.message : `other: ${String(e)}`; } };
  it('a file with neither Items nor PurchaseOrders', () => {
    expect(shape({})).toMatch(/neither Items nor PurchaseOrders/);
    expect(shape({ Items: null, PurchaseOrders: null })).toMatch(/neither Items nor PurchaseOrders/);
  });
  it('an unknown top-level key, naming it (a misspelt container would otherwise read as empty)', () => {
    expect(shape({ Items: [], Purchase_Orders: [] })).toMatch(/unknown key "Purchase_Orders"/);
    expect(shape({ items: fixture().Items, PurchaseOrders: [] })).toMatch(/unknown key "items"/);
  });
  it('one container alone is fine (an items-only file)', () => {
    expect(shape({ Items: fixture().Items })).toBe('accepted');
    expect(shape({ PurchaseOrders: fixture().PurchaseOrders })).toBe('accepted');
  });
  it('a Sage page whose $totalResults is more than the rows read', () => {
    const rows = fixture().Items.$resources;
    expect(shape({ Items: { $totalResults: 383, $resources: rows } })).toMatch(/Items: \$totalResults is 383 but 20 rows were read/);
    expect(shape({ Items: [{ $totalResults: 30, $resources: rows.slice(0, 10) }, { $totalResults: 30, $resources: rows.slice(10) }] })).toMatch(/\$totalResults is 30 but 20 rows/);
    expect(shape({ Items: { $totalResults: 20, $resources: rows } })).toBe('accepted');
    expect(shape({ Items: [{ $totalResults: 20, $next: 'n', $resources: rows.slice(0, 10) }, { $totalResults: 20, $resources: rows.slice(10) }] })).toBe('accepted');
  });
  it('a page that has a $next link', () => {
    const rows = fixture().Items.$resources;
    expect(shape({ Items: { $totalResults: 20, $next: 'https://api.example/items?$startIndex=20', $resources: rows } })).toMatch(/Items: the last page has a \$next link/);
    expect(shape({ Items: { $next: null, $resources: rows } })).toBe('accepted');
  });
});

describe('container shapes', () => {
  it('takes rows as an array, a Sage page, or an array of pages', () => {
    const rows = fixture().Items.$resources;
    expect(rowsOf(rows, 'Items')).toHaveLength(20);
    expect(rowsOf({ $resources: rows }, 'Items')).toHaveLength(20);
    expect(rowsOf([{ $startIndex: 0, $next: 'n', $resources: rows.slice(0, 5) }, { $startIndex: 5, $resources: rows.slice(5) }], 'Items')).toHaveLength(20);
    expect(rowsOf(undefined, 'Items')).toEqual([]);
  });
  it('B9-D (round 9): an array mixing a page and plain rows is refused as a whole (the page must not be read as one bad row)', () => {
    const rows = fixture().Items.$resources;
    expect(() => rowsOf([{ $resources: rows.slice(0, 5), $totalResults: 20 }, rows[5]], 'Items')).toThrow(SageExportShapeError);
    expect(() => rowsOf([rows[0], { $resources: rows.slice(1) }], 'Items')).toThrow(/mixes pages .* and plain rows/);
    const f = fixture();
    (f as Record<string, unknown>).PurchaseOrders = [{ $resources: f.PurchaseOrders.slice(0, 9), $totalResults: 9, $startIndex: 0 }, f.PurchaseOrders[9]];
    expect(() => parseSageExport(f)).toThrow(SageExportShapeError);
    // a plain array of rows, and an array of pages, still read
    expect(rowsOf(rows, 'Items')).toHaveLength(20);
    expect(rowsOf([{ $startIndex: 0, $next: 'n', $resources: rows.slice(0, 5) }, { $startIndex: 5, $resources: rows.slice(5) }], 'Items')).toHaveLength(20);
  });
  it('B9 (round 9): a Sage "none" id of 0 or an empty Category is refused (fail closed), the reason says it is unknown whether Sage means none', () => {
    const item = { ID: 1, Code: 'A', Description: 'a', Active: true, Physical: true };
    const po = (line: Record<string, unknown>) => ({ ID: 9, DocumentNumber: 'P1', Date: '2026-02-01', Status: 'Pending', SupplierId: 3, Exclusive: 100, Tax: 15, Total: 115,
      Lines: [{ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, ...line }] });
    const reasons = (file: Record<string, unknown>) => parseSageExport(file).refusals.flatMap((r) => r.reasons).join(' | ');
    for (const file of [
      { Items: [item], PurchaseOrders: [po({ ItemId: 0 })] }, { Items: [item], PurchaseOrders: [po({ SelectionId: '0' })] },
      { Items: [{ ...item, TaxTypeIdSales: 0 }] }, { Items: [{ ...item, Category: {} }] }, { Items: [{ ...item, Category: { ID: 0, Description: '' } }] },
    ]) expect(reasons(file)).toMatch(/id 0 \/ empty: unknown whether Sage means none/);
    // still refused, never read as "no item" / "no category"
    expect(parseSageExport({ Items: [item], PurchaseOrders: [po({ ItemId: 0 })] }).purchaseOrders).toHaveLength(0);
    expect(parseSageExport({ Items: [{ ...item, Category: {} }] }).items).toHaveLength(0);
  });
  it('refuses a file that is not an object, and a key that is not rows', () => {
    expect(() => parseSageExport([])).toThrow(SageExportShapeError);
    expect(() => parseSageExport({ Items: 'x' })).toThrow(SageExportShapeError);
  });
});

describe('item rows', () => {
  it('refuses a row that is not an object', () => expect(reasons(parseSageItem('x', 0))).toContain('the row must be an object'));
  it('needs ID, Code, Description, Active and Physical, and lists every missing one', () => {
    const r = parseSageItem({}, 3);
    expect(r.ok).toBe(false);
    expect(reasons(r)).toEqual(expect.arrayContaining(['ID is required', 'Code is required', 'Description is required', 'Active must be true or false', 'Physical must be true or false']));
    if (!r.ok) expect(r.refusal.label).toBe('items[3]');
  });
  it('refuses a code over 50 characters and a non-text description', () => {
    expect(reasons(parseSageItem(item({ Code: 'x'.repeat(51) }), 0))).toContain('Code is longer than 50 characters');
    expect(reasons(parseSageItem(item({ Description: 12 }), 0))).toContain('Description must be text');
  });
  it('refuses a tax type it does not know instead of guessing', () => {
    expect(reasons(parseSageItem(item({ TaxTypeIdSales: 7 }), 0))[0]).toMatch(/TaxTypeIdSales 7 is not a tax type/);
    expect(reasons(parseSageItem(item({ TaxTypeIdPurchases: 'abc' }), 0))).toContain('TaxTypeIdPurchases must be a Sage numeric id');
  });
  it('maps tax types 1, 2, 3 and lets a missing one stay null', () => {
    const r = parseSageItem(item({ TaxTypeIdSales: 2, TaxTypeIdPurchases: 3 }), 0);
    expect(r.ok && [r.value.taxSales, r.value.taxPurchases]).toEqual(['zero', 'exempt']);
    const n = parseSageItem(item({ TaxTypeIdSales: null, TaxTypeIdPurchases: undefined }), 0);
    expect(n.ok && [n.value.taxSales, n.value.taxPurchases]).toEqual([null, null]);
  });
  it('refuses a negative or non-numeric price or cost', () => {
    expect(reasons(parseSageItem(item({ PriceExclusive: -1 }), 0))).toContain('PriceExclusive must be not negative');
    expect(reasons(parseSageItem(item({ LastCost: '5' }), 0))).toContain('LastCost must be a number');
  });
  it('refuses a third decimal on PriceExclusive (it is a price the books keep), as PO amounts do', () => {
    expect(refusedFor(parseSageItem(item({ PriceExclusive: 10.005 }), 0))).toMatch(/PriceExclusive must be whole cents/);
    const ok = parseSageItem(item({ PriceExclusive: 10.5 }), 0);
    expect(ok.ok && ok.value.priceExclusive).toBe(10.5);
  });
  it('rounds a cost to whole cents', () => {
    const r = parseSageItem(item({ AverageCost: 59.123456, LastCost: 12.345 }), 0);
    expect(r.ok && [r.value.averageCost, r.value.lastCost]).toEqual([59.12, 12.35]);
  });
  it('needs a category to carry both ID and Description, or be null', () => {
    expect(reasons(parseSageItem(item({ Category: { ID: 5 } }), 0))).toEqual(['Category needs both ID and Description']);
    expect(reasons(parseSageItem(item({ Category: 'Optics' }), 0))).toContain('Category must be an object {ID, Description} or null');
    const none = parseSageItem(item({ Category: null }), 0);
    expect(none.ok && none.value.category).toBeNull();
  });
  it('ignores a QuantityOnHand that is not a number (the field is discarded anyway): the item is accepted, nothing of it kept, but counted (R15-L5)', () => {
    for (const v of ['12', 'lots', true, { n: 1 }, [3]]) {
      const r = parseSageItem(item({ QuantityOnHand: v }), 0);
      expect(r.ok, JSON.stringify(v)).toBe(true);
      expect(JSON.stringify(r)).not.toContain('lots');
    }
  });
  it('a numeric QuantityOnHand is only counted, its value never kept', () => {
    const r = parseSageItem(item({ QuantityOnHand: 99 }), 0);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('99');
  });
  it('refuses EVERY row that shares an ID or a Code, whichever comes first', () => {
    const f = fixture();
    f.Items.$resources[1] = { ...f.Items.$resources[1], ID: f.Items.$resources[0]!.ID };
    f.Items.$resources[3] = { ...f.Items.$resources[3], Code: f.Items.$resources[2]!.Code };
    const p = parseSageExport(f);
    expect(p.items).toHaveLength(16);
    expect(p.refusals.filter((r) => r.entity === 'item').map((r) => r.code).sort()).toEqual(['duplicate_code', 'duplicate_code', 'duplicate_id', 'duplicate_id']);
  });
  it('B5-F (round 5): a second row with the same ID or Code that is itself INVALID refuses the valid row too', () => {
    const f = fixture();
    f.Items.$resources.push({ ID: 50001, Code: 'OTHER-1', Description: 'Something else', Active: 'yes', Physical: true, PriceExclusive: 999 }); // same ID, bad Active
    f.Items.$resources.push({ ID: 60000, Code: f.Items.$resources[1]!.Code, Description: 'Same code', Active: 'yes', Physical: true }); // same Code, bad Active
    (f.Items as Record<string, unknown>).$totalResults = f.Items.$resources.length; // the page says what it holds (B10-3a)
    const p = parseSageExport(f);
    expect(p.items.map((i) => i.id)).not.toContain('50001');
    expect(p.items.map((i) => i.id)).not.toContain(String(f.Items.$resources[1]!.ID));
    expect(p.items).toHaveLength(18);
    expect(p.refusals.filter((r) => r.code === 'duplicate_id' || r.code === 'duplicate_code').map((r) => r.code).sort()).toEqual(['duplicate_code', 'duplicate_id']);
    expect(p.refusals.filter((r) => r.code === 'duplicate_id')[0]!.reasons[0]).toMatch(/another row with it is invalid/);
  });
  it('B5-F (round 5): the same for a purchase order: its twin by ID or DocumentNumber is invalid, both are refused', () => {
    const f = fixture();
    f.PurchaseOrders.push({ ...f.PurchaseOrders[0]!, ID: 999999, Total: 1, Date: 'not a date' }); // same DocumentNumber
    f.PurchaseOrders.push({ ...f.PurchaseOrders[1]!, DocumentNumber: 'PO-OTHER', Date: 'not a date' }); // same ID
    const p = parseSageExport(f);
    expect(p.purchaseOrders.map((x) => x.documentNumber)).not.toContain(String(f.PurchaseOrders[0]!.DocumentNumber));
    expect(p.purchaseOrders.map((x) => x.id)).not.toContain(String(f.PurchaseOrders[1]!.ID));
    expect(p.purchaseOrders).toHaveLength(8);
    expect(p.refusals.filter((r) => r.code === 'duplicate_number' || r.code === 'duplicate_id').map((r) => r.code).sort()).toEqual(['duplicate_id', 'duplicate_number']);
  });
  it('B5-F (round 5): an invalid row whose ID or Code is unreadable makes no claim on a valid one', () => {
    const f = fixture();
    f.Items.$resources.push({ ID: 'abc', Code: '', Description: 'x' }, { Code: 12, Description: 'y' });
    (f.Items as Record<string, unknown>).$totalResults = f.Items.$resources.length; // the page says what it holds (B10-3a)
    expect(parseSageExport(f).items).toHaveLength(20);
  });
  it('refuses a later item that describes a category ID differently, or reuses a category name under another ID', () => {
    const f = fixture();
    const cat = (i: number, ID: number, Description: string) => { f.Items.$resources[i] = { ...f.Items.$resources[i], Category: { ID, Description } }; };
    cat(0, 10, 'Optics');
    cat(1, 10, 'Fibre optics'); // same ID, other description
    cat(2, 99, 'optics'); // other ID, same name (case-insensitive)
    const p = parseSageExport(f);
    expect(p.refusals.map((r) => [r.label, r.code]).sort()).toEqual([['FIB-0002', 'category_description_conflict'], ['FIB-0003', 'category_name_collision']]);
  });
});

describe('purchase order rows', () => {
  it('needs its header fields and at least one line', () => {
    const r = parseSagePurchaseOrder({}, 0);
    expect(!r.ok && r.refusal.reasons).toEqual(expect.arrayContaining(['ID is required', 'DocumentNumber is required', 'Date is required', 'Status is required', 'SupplierId is required', 'Exclusive is required', 'Lines must be a non-empty array']));
  });
  it('refuses a date that is not real, and takes a date-time as its calendar date', () => {
    expect(refusedFor(parseSagePurchaseOrder(po({ Date: '2026-02-30' }), 0))).toMatch(/Date must be a real date/);
    const plain = parseSagePurchaseOrder(po({ Date: '2026-03-04T23:59:59' }), 0);
    expect(plain.ok && plain.value.date).toBe('2026-03-04'); // no zone: the calendar date as written
  });
  it('refuses a header whose Exclusive + Tax is not Total', () => {
    const r = parseSagePurchaseOrder(po({ Total: 1 }), 0);
    expect(!r.ok && r.refusal.reasons[0]).toMatch(/is not Total 1/);
  });
  it('refuses a third decimal on a header amount', () => {
    expect(refusedFor(parseSagePurchaseOrder(po({ Exclusive: 10.005, Tax: 0, Total: 10.005 }), 0))).toMatch(/Exclusive must be whole cents/);
  });
  it('line VAT: a rate by TaxPercentage or by TaxTypeId; both must agree; neither is refused', () => {
    const line = (over: Row) => ({ ...(po().Lines as Row[])[0], ...over });
    const run = (l: Row) => parseSagePurchaseOrder(po({ Lines: [l] }), 0);
    expect(refusedFor(run(line({ TaxPercentage: 0, TaxTypeId: 1 })))).toMatch(/TaxPercentage 0 disagrees with TaxTypeId 1/);
    expect(refusedFor(run(line({ TaxPercentage: undefined, TaxTypeId: undefined })))).toMatch(/needs TaxPercentage or TaxTypeId/);
    expect(refusedFor(run(line({ TaxTypeId: 9 })))).toMatch(/TaxTypeId 9 is not a tax type/);
    const viaType = parseSagePurchaseOrder(po({ Exclusive: 100, Tax: 15, Total: 115, Lines: [line({ TaxPercentage: undefined, TaxTypeId: 1, Quantity: 1, UnitPriceExclusive: 100, Exclusive: 100, Tax: 15, Total: 115 })] }), 0);
    expect(viaType.ok && viaType.value.lines[0]!.taxRate).toBe(15);
  });
  it('line quantity: positive, at most two decimals', () => {
    const run = (q: unknown) => parseSagePurchaseOrder(po({ Lines: [{ ...(po().Lines as Row[])[0], Quantity: q }] }), 0);
    expect(refusedFor(run(0))).toMatch(/Quantity must be more than 0/);
    expect(refusedFor(run(1.005))).toMatch(/Quantity has at most two decimals/);
  });
  it('a line names its item by ItemId or SelectionId; two different ones are refused', () => {
    const l = (over: Row) => ({ ...(po().Lines as Row[])[0], ...over });
    const run = (over: Row) => parseSagePurchaseOrder(po({ Lines: [l(over)] }), 0);
    expect(run({ ItemId: undefined, SelectionId: 50002 })).toMatchObject({ ok: true, value: { lines: [{ itemId: '50002' }] } });
    expect(refusedFor(run({ ItemId: 50001, SelectionId: 50002 }))).toMatch(/ItemId and SelectionId name different items/);
  });
  it('refuses EVERY row that shares an ID or a DocumentNumber', () => {
    const f = fixture();
    f.PurchaseOrders[1] = { ...f.PurchaseOrders[1], DocumentNumber: f.PurchaseOrders[0]!.DocumentNumber };
    f.PurchaseOrders[4] = { ...f.PurchaseOrders[4], ID: f.PurchaseOrders[3]!.ID };
    const p = parseSageExport(f);
    expect(p.purchaseOrders).toHaveLength(6);
    expect(p.refusals.map((r) => r.code).sort()).toEqual(['duplicate_id', 'duplicate_id', 'duplicate_number', 'duplicate_number']);
  });
  it('refuses a status outside Pending / Overdue / Invoiced / Cancelled, and a line naming an item the export lacks', () => {
    const f = fixture();
    f.PurchaseOrders[0] = { ...f.PurchaseOrders[0], Status: 'Draft' };
    f.PurchaseOrders[1] = { ...f.PurchaseOrders[1], Lines: [{ ...(f.PurchaseOrders[1]!.Lines as Row[])[0], ItemId: 777777 }] };
    const p = parseSageExport(f);
    expect(p.refusals.map((r) => r.code).sort()).toEqual(['line_item_unknown', 'unknown_status']);
    expect(p.purchaseOrders).toHaveLength(8);
  });
  it('a refused PO still counts in the export PO total', () => {
    const f = fixture();
    f.PurchaseOrders[0] = { ...f.PurchaseOrders[0], Status: 'Draft' };
    expect(parseSageExport(f).exportPoTotalCents).toBe(parseSageExport(fixture()).exportPoTotalCents);
  });
});
