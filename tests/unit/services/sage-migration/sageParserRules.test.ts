/**
 * More parser rules, split from sageParser.test.ts: foreign currency (F6), PO rows without a Total (F7c), dates with a zone, the VAT
 * rate of the PO date, and the items a PO line may name.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { parseSageItem } from '@/modules/accounting/services/sage-migration/sageItemParser';
import { parseSagePurchaseOrder } from '@/modules/accounting/services/sage-migration/sagePurchaseOrderParser';

type Row = Record<string, unknown>;
const fixture = (): { Items: { $resources: Row[] }; PurchaseOrders: Row[] } =>
  JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'));
const po = (over: Row = {}): Row => ({ ...fixture().PurchaseOrders[0], ...over });
const refusedFor = (r: ReturnType<typeof parseSageItem> | ReturnType<typeof parseSagePurchaseOrder>): string =>
  (r.ok ? 'NOT REFUSED' : r.refusal.reasons.join(' | '));

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

describe('the item codes a PO line may be suffixed with, and the items a line may name', () => {
  it('itemCodes holds every item row with a readable ID and Code, refused or duplicated ones included (the plan decides the link)', () => {
    const f = fixture();
    f.Items.$resources[2] = { ...f.Items.$resources[2], TaxTypeIdSales: 9 }; // 50003 refused
    f.Items.$resources[4] = { ...f.Items.$resources[4], Code: f.Items.$resources[3]!.Code }; // 50004 and 50005 duplicated
    const p = parseSageExport(f);
    expect(p.itemCodes['50003']).toBe('FIB-0003');
    expect(p.itemCodes['50004']).toBe('FIB-0004');
    expect(p.itemCodes['50005']).toBe('FIB-0004');
    expect(p.itemCodes['50001']).toBe('FIB-0001');
  });
  it('L13: two rows with one Sage id: the suffix names the FIRST seen code, whichever way the rows are ordered or refused', () => {
    const f = fixture();
    f.Items.$resources[1] = { ...f.Items.$resources[1], ID: 50001 }; // 50001 is now FIB-0001 (row 0) and FIB-0002 (row 1)
    expect(parseSageExport(f).itemCodes['50001']).toBe('FIB-0001');
    const g = fixture();
    g.Items.$resources[0] = { ...g.Items.$resources[0], TaxTypeIdSales: 9 }; // the first is refused, the second is accepted
    g.Items.$resources[1] = { ...g.Items.$resources[1], ID: 50001 };
    expect(parseSageExport(g).itemCodes['50001']).toBe('FIB-0001');
    const h = fixture();
    h.Items.$resources[1] = { ...h.Items.$resources[1], ID: 50001, TaxTypeIdSales: 9 }; // the later is refused
    expect(parseSageExport(h).itemCodes['50001']).toBe('FIB-0001');
  });
  it('an item row whose Code is unreadable (NUL, empty, too long) has no code to name it by', () => {
    const f = fixture();
    f.Items.$resources[0] = { ...f.Items.$resources[0], Code: 'a\u0000b' };
    f.Items.$resources[1] = { ...f.Items.$resources[1], Code: '' };
    f.Items.$resources[2] = { ...f.Items.$resources[2], Code: 'x'.repeat(51) };
    const p = parseSageExport(f);
    expect([p.itemCodes['50001'], p.itemCodes['50002'], p.itemCodes['50003']]).toEqual([undefined, undefined, undefined]);
  });
  it('a PO naming a refused item WITH a readable code is accepted by the parser (its line goes unlinked in the plan)', () => {
    const f = fixture();
    f.Items.$resources[4] = { ...f.Items.$resources[4], TaxTypeIdSales: 9 }; // 50005, named by POs 197, 201, 205
    const p = parseSageExport(f);
    expect(p.refusals.filter((r) => r.entity === 'purchase_order')).toEqual([]);
    expect(p.purchaseOrders).toHaveLength(10);
  });
  it('a PO naming a refused item with NO readable code is refused line_item_refused: there is nothing to name it by', () => {
    const f = fixture();
    f.Items.$resources[4] = { ...f.Items.$resources[4], Code: 'a\u0000b' };
    const refused = parseSageExport(f).refusals.filter((r) => r.entity === 'purchase_order');
    expect(refused.map((r) => r.label).sort()).toEqual(['PO0000197', 'PO0000201', 'PO0000205']);
    expect(refused.every((r) => r.code === 'line_item_refused')).toBe(true);
    expect(refused[0]!.reasons[0]).toMatch(/names item 50005, which is refused and has no readable Code/);
  });
  it('a PO naming an item the export does not contain is refused line_item_unknown', () => {
    const f = fixture();
    f.PurchaseOrders[1] = { ...f.PurchaseOrders[1], Lines: [{ ...(f.PurchaseOrders[1]!.Lines as Row[])[0], ItemId: 777777 }] };
    expect(parseSageExport(f).refusals.map((r) => r.code)).toEqual(['line_item_unknown']);
  });
});

describe('invalid_text: a NUL byte or a lone surrogate in a text field refuses the row, naming the field', () => {
  const NUL = 'a\u0000b';
  const LONE_HIGH = 'X\ud800';
  const LONE_LOW = '\udc00Y';
  const item = (over: Row) => ({ ...fixture().Items.$resources[0], ...over });
  const code = (r: ReturnType<typeof parseSageItem> | ReturnType<typeof parseSagePurchaseOrder>) => (r.ok ? 'ok' : `${r.refusal.code}: ${r.refusal.reasons.join(' | ')}`);

  it('item Code, Description and category description', () => {
    expect(code(parseSageItem(item({ Code: NUL }), 0))).toMatch(/^invalid_text: Code contains a NUL byte/);
    expect(code(parseSageItem(item({ Description: LONE_HIGH }), 0))).toMatch(/^invalid_text: Description contains a lone surrogate/);
    expect(code(parseSageItem(item({ Category: { ID: 5, Description: LONE_LOW } }), 0))).toMatch(/^invalid_text: .*Description contains a lone surrogate/);
    expect(code(parseSageItem(item({ Category: { ID: 5, Description: NUL } }), 0))).toMatch(/^invalid_text/);
  });
  it('PO DocumentNumber, Reference, Comments, SupplierName and a line Description', () => {
    expect(code(parseSagePurchaseOrder(po({ DocumentNumber: NUL }), 0))).toMatch(/^invalid_text: DocumentNumber contains a NUL byte/);
    expect(code(parseSagePurchaseOrder(po({ Reference: NUL }), 0))).toMatch(/^invalid_text: Reference/);
    expect(code(parseSagePurchaseOrder(po({ Comments: LONE_LOW }), 0))).toMatch(/^invalid_text: Comments/);
    expect(code(parseSagePurchaseOrder(po({ SupplierName: LONE_HIGH }), 0))).toMatch(/^invalid_text: SupplierName/);
    const line = { ...(po().Lines as Row[])[0], Description: NUL };
    expect(code(parseSagePurchaseOrder(po({ Lines: [line] }), 0))).toMatch(/^invalid_text: Lines\[0\]\.Description contains a NUL byte/);
  });
  it('well-formed text is fine: an emoji pair, accents, a tab', () => {
    expect(code(parseSageItem(item({ Description: 'caf\u00e9 \ud83d\ude00\tok' }), 0))).toBe('ok');
  });
  it('two codes that would collapse to the same UTF-8 are each refused, not imported as one', () => {
    const f = fixture();
    f.Items.$resources[0] = { ...f.Items.$resources[0], Code: 'X\ud800' };
    f.Items.$resources[1] = { ...f.Items.$resources[1], Code: 'X\ud801' };
    const p = parseSageExport(f);
    expect(p.refusals.filter((r) => r.code === 'invalid_text').map((r) => r.sageId).sort()).toEqual(['50001', '50002']);
    expect(p.items).toHaveLength(18);
  });
});

describe('F4 more: a page that is not the whole export', () => {
  const shape = (f: unknown) => { try { parseSageExport(f); return 'accepted'; } catch (e) { return e instanceof Error ? e.message : String(e); } };
  const rows = () => fixture().Items.$resources;
  it('$totalResults must be an integer number: a string, a float, a negative are refused', () => {
    expect(shape({ Items: { $totalResults: '20', $resources: rows() } })).toMatch(/Items: \$totalResults must be a whole number/);
    expect(shape({ Items: { $totalResults: 20.5, $resources: rows() } })).toMatch(/\$totalResults must be a whole number/);
    expect(shape({ Items: { $totalResults: -1, $resources: rows() } })).toMatch(/\$totalResults must be a whole number/);
    expect(shape({ Items: { $totalResults: 20, $resources: rows() } })).toBe('accepted');
    expect(shape({ Items: { $resources: rows() } })).toBe('accepted');
  });
  it('a page with $startIndex above 0 is the middle of an export, not the whole', () => {
    expect(shape({ Items: { $startIndex: 200, $totalResults: 20, $resources: rows() } })).toMatch(/Items: a page starts at \$startIndex 200/);
    expect(shape({ Items: { $startIndex: 0, $totalResults: 20, $resources: rows() } })).toBe('accepted');
    expect(shape({ Items: { $startIndex: '0', $resources: rows() } })).toMatch(/\$startIndex must be a whole number/);
  });
  it('a page with a $back link is not the first', () => {
    expect(shape({ Items: { $back: 'https://api.example/items?$startIndex=0', $resources: rows() } })).toMatch(/Items: a page has a \$back link/);
    expect(shape({ Items: { $back: null, $resources: rows() } })).toBe('accepted');
  });
  it('an array of pages is the whole export only if each page starts where the one before ended: later pages may carry $startIndex and $back', () => {
    const ok = [{ $startIndex: 0, $resources: rows().slice(0, 10) }, { $startIndex: 10, $back: 'x', $resources: rows().slice(10) }];
    expect(shape({ Items: ok })).toBe('accepted');
    expect(shape({ Items: [{ $startIndex: 10, $resources: rows().slice(10) }, ok[0]] })).toMatch(/\$startIndex 10/);
    expect(shape({ Items: [{ $startIndex: 0, $resources: rows().slice(0, 10) }, { $startIndex: 12, $resources: rows().slice(10) }] })).toMatch(/\$startIndex 12, but 10 rows came before/);
    expect(shape({ Items: [{ $startIndex: 0, $resources: rows().slice(0, 10) }, { $startIndex: 0, $resources: rows().slice(10) }] })).toMatch(/\$startIndex 0, but 10 rows came before/);
  });
});

describe('L5 (round 5): whole-cent checks hold at large amounts (an absolute tolerance on n*100 refused them)', () => {
  const big = (over: Row, line: Row = {}) => parseSagePurchaseOrder(po({ Exclusive: 123456789.1, Tax: 18518518.37, Total: 141975307.47, ...over,
    Lines: [{ ...(po().Lines as Row[])[0], UnitPriceExclusive: 123456789.1, Quantity: 1, Exclusive: 123456789.1, Tax: 18518518.37, ...line }] }), 0);
  it('a header and a line of R123 456 789.10 + R18 518 518.37 are accepted', () => {
    expect(refusedFor(big({}))).toBe('NOT REFUSED');
  });
  it('R999 999 999.99 is accepted, and a third decimal is still refused at that size', () => {
    // 2500000000.43 * 100 is 250000000043.00003: whole cents all the same (the old absolute tolerance refused it)
    expect(refusedFor(big({ Exclusive: 2500000000.43, Tax: 0, Total: 2500000000.43 }, { Exclusive: 2500000000.43, Tax: 0, UnitPriceExclusive: 2500000000.43 }))).toBe('NOT REFUSED');
    expect(refusedFor(big({ Exclusive: 123456789.105, Tax: 0, Total: 123456789.105 }))).toMatch(/Exclusive must be whole cents/);
  });
  it('a large quantity with two decimals is accepted, a third decimal refused', () => {
    expect(refusedFor(big({}, { Quantity: 12345678.91 }))).toBe('NOT REFUSED');
    expect(refusedFor(big({}, { Quantity: 2500000000.43 }))).toBe('NOT REFUSED');
    expect(refusedFor(big({}, { Quantity: 12345678.915 }))).toMatch(/Quantity has at most two decimals/);
  });
  it('the small cases still behave: 0.07 and 1.15 are whole cents, 1.005 and 10.005 are not', () => {
    const r = (v: number) => refusedFor(parseSagePurchaseOrder(po({ Exclusive: v, Tax: 0, Total: v }), 0));
    expect(r(0.07)).not.toMatch(/Exclusive must be whole cents/);
    expect(r(1.15)).not.toMatch(/Exclusive must be whole cents/);
    expect(r(1.005)).toMatch(/Exclusive must be whole cents/);
    expect(r(10.005)).toMatch(/Exclusive must be whole cents/);
  });
});

describe('B8-F (round 8): LineType (assumed 0 = item, 1 = account): a line that is not an item is never linked to one', () => {
  const withType = (type: unknown, over: Row = {}) => parseSagePurchaseOrder(po({ Lines: [{ ...(po().Lines as Row[])[0], ItemId: undefined, SelectionId: 50002, ...(type === undefined ? {} : { LineType: type }), ...over }],
    Exclusive: 2400, Tax: 360, Total: 2760 }), 0);
  const codeOf = (r: ReturnType<typeof parseSagePurchaseOrder>) => (r.ok ? 'ok' : r.refusal.code);
  it('absent, 0 and "0" are item lines, as before (the SelectionId is the item)', () => {
    for (const t of [undefined, 0, '0', null, '']) {
      const r = withType(t);
      expect(codeOf(r), String(t)).toBe('ok');
      expect(r.ok && r.value.lines[0]!.itemId).toBe('50002');
    }
  });
  it('1 (an account line) refuses the PO as po_account_line_unsupported, naming the account', () => {
    for (const t of [1, '1']) {
      const r = withType(t);
      expect(codeOf(r)).toBe('po_account_line_unsupported');
      expect(!r.ok && r.refusal.reasons.join(' ')).toMatch(/Lines\[0\]\.LineType 1 is an account line \(account 50002\).*ledger account, not an item/);
    }
  });
  it('any other value refuses it as po_line_type_unknown', () => {
    for (const t of [2, 7, -1, 'x', 1.5, true]) expect(codeOf(withType(t)), String(t)).toBe('po_line_type_unknown');
  });
  it('a line type is checked on every line, and an account line wins over an unknown one in the code', () => {
    const mixed = parseSagePurchaseOrder(po({ Lines: [{ ...(po().Lines as Row[])[0], LineType: 9 }, { ...(po().Lines as Row[])[1], LineType: 1, SelectionId: 7 }] }), 0);
    expect(codeOf(mixed)).toBe('po_account_line_unsupported');
  });
});
