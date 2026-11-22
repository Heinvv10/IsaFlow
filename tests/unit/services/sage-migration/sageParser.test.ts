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
    for (const i of p.items) expect(Object.keys(i).filter((k) => /quant|stock|opening/i.test(k))).toEqual(['hadQuantityOnHand']);
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
    expect(shape({ Items: [{ $totalResults: 20, $resources: rows.slice(0, 10) }, { $totalResults: 20, $resources: rows.slice(10) }] })).toBe('accepted');
  });
  it('a page that has a $next link', () => {
    const rows = fixture().Items.$resources;
    expect(shape({ Items: { $totalResults: 20, $next: 'https://api.example/items?$startIndex=20', $resources: rows } })).toMatch(/Items: a page has a \$next link/);
    expect(shape({ Items: { $next: null, $resources: rows } })).toBe('accepted');
  });
});

describe('container shapes', () => {
  it('takes rows as an array, a Sage page, or an array of pages', () => {
    const rows = fixture().Items.$resources;
    expect(rowsOf(rows, 'Items')).toHaveLength(20);
    expect(rowsOf({ $resources: rows }, 'Items')).toHaveLength(20);
    expect(rowsOf([{ $resources: rows.slice(0, 5) }, { $resources: rows.slice(5) }], 'Items')).toHaveLength(20);
    expect(rowsOf(undefined, 'Items')).toEqual([]);
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
  it('does not trust a row whose QuantityOnHand is malformed, and never keeps a valid one', () => {
    expect(reasons(parseSageItem(item({ QuantityOnHand: 'lots' }), 0))[0]).toMatch(/QuantityOnHand must be a number/);
    const r = parseSageItem(item({ QuantityOnHand: 99 }), 0);
    expect(r.ok && r.value.hadQuantityOnHand).toBe(true);
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
    const viaType = parseSagePurchaseOrder(po({ Exclusive: 100, Tax: 15, Total: 115, Lines: [line({ TaxPercentage: undefined, TaxTypeId: 1, Quantity: 1, UnitPriceExclusive: 100, Exclusive: 100, Tax: 15 })] }), 0);
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

describe('F6: a PO in a foreign currency is refused, not imported at its foreign figures', () => {
  const code = (over: Row) => { const r = parseSagePurchaseOrder(po(over), 0); return r.ok ? 'ok' : `${r.refusal.code}: ${r.refusal.reasons.join(' | ')}`; };
  it('ZAR and rate 1, in any of the forms Sage uses, are fine; so is no currency field at all', () => {
    expect(code({})).toBe('ok');
    expect(code({ Currency: 'ZAR', ExchangeRate: 1 })).toBe('ok');
    expect(code({ CurrencyCode: ' zar ' })).toBe('ok');
    expect(code({ Currency: { Code: 'ZAR', Description: 'Rand' } })).toBe('ok');
    expect(code({ CurrencyId: 1, Currency: { Code: 'ZAR' } })).toBe('ok');
    expect(code({ Currency: null, ExchangeRate: null, CurrencyId: null })).toBe('ok');
  });
  it('another currency, by text or by object, is foreign_currency', () => {
    expect(code({ Currency: 'USD' })).toMatch(/^foreign_currency: .*Currency is "USD"/);
    expect(code({ CurrencyCode: 'EUR' })).toMatch(/^foreign_currency/);
    expect(code({ Currency: { Code: 'GBP', Description: 'Pound' } })).toMatch(/^foreign_currency/);
  });
  it('an exchange rate that is not 1 is foreign_currency, whatever the currency says', () => {
    expect(code({ ExchangeRate: 18.5 })).toMatch(/^foreign_currency: .*ExchangeRate is 18.5/);
    expect(code({ Currency: 'ZAR', ExchangeRate: 1.0001 })).toMatch(/^foreign_currency/);
    expect(code({ ExchangeRate: 'x' })).toMatch(/^foreign_currency/);
  });
  it('a currency id with nothing saying ZAR cannot be told from a foreign one: refused', () => {
    expect(code({ CurrencyId: 2 })).toMatch(/^foreign_currency: .*CurrencyId 2 .*cannot be told/);
  });
  it('any other field about currency or exchange is refused the same way (the like)', () => {
    expect(code({ ForeignCurrencyTotal: 100 })).toMatch(/^foreign_currency/);
    expect(code({ ExchangeRateDate: '2026-01-01' })).toMatch(/^foreign_currency/);
  });
});

describe('F7c: the export PO total says how many rows it could not count', () => {
  it('counts rows whose Total is not a number (and rows that are not objects)', () => {
    const f = fixture();
    f.PurchaseOrders[1] = { ...f.PurchaseOrders[1], Total: '230.00' };
    f.PurchaseOrders[2] = { ...f.PurchaseOrders[2], Total: undefined };
    (f.PurchaseOrders as unknown[])[3] = 'junk';
    const p = parseSageExport(f);
    expect(p.exportRowsWithoutTotal).toBe(3);
    expect(p.exportPoTotalCents).toBe(parseSageExport(fixture()).exportPoTotalCents - [1, 2, 3].reduce((s, i) => s + Math.round((fixture().PurchaseOrders[i]!.Total as number) * 100), 0));
  });
  it('is 0 for a file whose every PO has a Total', () => {
    expect(parseSageExport(fixture()).exportRowsWithoutTotal).toBe(0);
  });
});

describe('dates with a zone convert to the South African calendar date (UTC+2, no daylight saving)', () => {
  const dateOf = (Date_: string) => { const r = parseSagePurchaseOrder(po({ Date: Date_ }), 0); return r.ok ? r.value.date : refusedFor(r); };
  it('22:00 UTC is already the next day in Johannesburg', () => {
    expect(dateOf('2026-03-04T22:00:00Z')).toBe('2026-03-05');
    expect(dateOf('2026-03-04T21:59:59Z')).toBe('2026-03-04');
    expect(dateOf('2026-03-04T22:00:00.000Z')).toBe('2026-03-05');
  });
  it('an offset is applied before the date is taken', () => {
    expect(dateOf('2026-03-04T23:30:00-05:00')).toBe('2026-03-05'); // 04:30 UTC on the 5th
    expect(dateOf('2026-03-05T00:30:00+02:00')).toBe('2026-03-05'); // already Johannesburg time
    expect(dateOf('2026-03-05T00:30:00+05:30')).toBe('2026-03-04'); // 19:00 UTC on the 4th is 21:00 in Johannesburg
  });
  it('crosses a month and a year end', () => {
    expect(dateOf('2026-12-31T23:00:00Z')).toBe('2027-01-01');
    expect(dateOf('2026-02-28T22:00:00Z')).toBe('2026-03-01');
  });
  it('a date-time with no zone keeps its own calendar date, a date-only value is itself', () => {
    expect(dateOf('2026-03-04T22:00:00')).toBe('2026-03-04');
    expect(dateOf('2026-03-04')).toBe('2026-03-04');
  });
  it('refuses a time part it cannot read, and DeliveryDate converts the same way', () => {
    expect(dateOf('2026-03-04Tbanana')).toMatch(/Date must be a real date/);
    const r = parseSagePurchaseOrder(po({ DeliveryDate: '2026-03-04T22:00:00Z' }), 0);
    expect(r.ok && r.value.deliveryDate).toBe('2026-03-05');
  });
});

describe('line VAT is the rate that applied on the PO date (14% before 2018-04-01, 15% from then)', () => {
  const lineOn = (date: string, over: Row) => {
    const l = { ...(po().Lines as Row[])[0], TaxPercentage: undefined, TaxTypeId: undefined, ...over };
    return parseSagePurchaseOrder(po({ Date: date, Lines: [l] }), 0);
  };
  const rate = (r: ReturnType<typeof parseSagePurchaseOrder>) => (r.ok ? r.value.lines[0]!.taxRate : refusedFor(r));
  it('tax type 1 (standard) takes the rate of the date', () => {
    expect(rate(lineOn('2018-03-31', { TaxTypeId: 1 }))).toBe(14);
    expect(rate(lineOn('2018-04-01', { TaxTypeId: 1 }))).toBe(15);
    expect(rate(lineOn('2026-06-01', { TaxTypeId: 1 }))).toBe(15);
  });
  it('a percentage must be that rate, or 0', () => {
    expect(rate(lineOn('2018-03-31', { TaxPercentage: 14 }))).toBe(14);
    expect(rate(lineOn('2018-03-31', { TaxPercentage: 15 }))).toMatch(/TaxPercentage 15 is not the VAT rate on 2018-03-31 \(14%/);
    expect(rate(lineOn('2018-04-01', { TaxPercentage: 14 }))).toMatch(/TaxPercentage 14 is not the VAT rate on 2018-04-01 \(15%/);
    expect(rate(lineOn('2026-06-01', { TaxPercentage: 10 }))).toMatch(/TaxPercentage 10 is not the VAT rate/);
    expect(rate(lineOn('2026-06-01', { TaxPercentage: 0 }))).toBe(0);
  });
  it('a PO dated before VAT began has no rate to check against: the line is refused with that reason', () => {
    expect(rate(lineOn('1990-01-01', { TaxPercentage: 14 }))).toMatch(/no VAT rate can be read for the PO date 1990-01-01/);
  });
  it('a percentage that disagrees with a tax type of the date is refused; zero-rated and exempt are 0', () => {
    expect(rate(lineOn('2018-03-31', { TaxPercentage: 15, TaxTypeId: 1 }))).toMatch(/is not the VAT rate|disagrees/);
    expect(rate(lineOn('2026-06-01', { TaxPercentage: 14, TaxTypeId: 1 }))).toMatch(/is not the VAT rate|disagrees/);
    expect(rate(lineOn('2026-06-01', { TaxTypeId: 2 }))).toBe(0);
    expect(rate(lineOn('2026-06-01', { TaxTypeId: 3 }))).toBe(0);
  });
});

describe('an item a PO line names must be one that is imported', () => {
  it('itemCodes holds only the rows that survive: a refused or duplicated item is not in it', () => {
    const f = fixture();
    f.Items.$resources[2] = { ...f.Items.$resources[2], TaxTypeIdSales: 9 }; // 50003 refused
    f.Items.$resources[4] = { ...f.Items.$resources[4], Code: f.Items.$resources[3]!.Code }; // 50004 and 50005 duplicated
    const p = parseSageExport(f);
    expect(Object.keys(p.itemCodes)).not.toEqual(expect.arrayContaining(['50003']));
    expect(p.itemCodes['50004']).toBeUndefined();
    expect(p.itemCodes['50005']).toBeUndefined();
    expect(p.itemCodes['50001']).toBe('FIB-0001');
  });
  it('a PO whose line names a refused item is refused with line_item_refused (not line_item_unknown)', () => {
    const f = fixture();
    f.Items.$resources[4] = { ...f.Items.$resources[4], Code: f.Items.$resources[3]!.Code }; // 50005 (named by POs 197, 201, 205) duplicated
    const p = parseSageExport(f);
    const refused = p.refusals.filter((r) => r.entity === 'purchase_order');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((r) => r.code === 'line_item_refused')).toBe(true);
    expect(refused[0]!.reasons[0]).toMatch(/names item 50005, which is refused/);
  });
});
