/**
 * One Sage purchase-order row -> a typed SagePurchaseOrder, or a refusal naming every fault. PURE.
 *
 * Line VAT: a line gives `TaxPercentage` and/or `TaxTypeId`. The rate is TaxPercentage when present, else the tax type's rate
 * (sageTaxTypes); both present and disagreeing is refused. A line names its item by `ItemId` (alias `SelectionId`); both
 * present and different is refused.
 */
import type { RowResult, SagePoLine, SagePurchaseOrder } from './sageExportTypes';
import { isRaw, readDate, readId, readNumber, readText, type Raw } from './sageValues';
import { hasWholeCents } from '@/lib/money/wholeCents';
import { VatRateDateError } from '@/lib/vat/standardRate';
import { rateOf, standardRateOn, taxTypeFor } from './sageTaxTypes';

const MAX_LINES = 200;
const CURRENCY_KEY = /currenc|exchange/i;
const RATE_KEY = /exchange.*rate|^rate$/i;

/** The text a currency field says: a string, or the Code / Name / Description / ISO of an object. */
function currencyTexts(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (isRaw(v)) return ['Code', 'Name', 'Description', 'ISO', 'Symbol'].flatMap((k) => (typeof v[k] === 'string' ? [v[k] as string] : []));
  return [];
}
const isZar = (t: string): boolean => t.trim().toUpperCase() === 'ZAR';

/**
 * A PO in a foreign currency would be booked at its foreign figures as if they were rand. Every field about currency or exchange
 * (CurrencyId, Currency, CurrencyCode, ExchangeRate, anything with "currency" or "exchange" in its name) must say ZAR / rate 1 or be
 * empty. A CurrencyId alone cannot be told from a foreign one (the ids are Sage's), so it passes only beside a field saying ZAR.
 */
export function foreignCurrencyReasons(o: Raw): string[] {
  const keys = Object.keys(o).filter((k) => CURRENCY_KEY.test(k) && o[k] !== null && o[k] !== undefined && o[k] !== '');
  const saysZar = keys.some((k) => !/id$/i.test(k) && currencyTexts(o[k]).some(isZar));
  const why: string[] = [];
  for (const k of keys) {
    const v = o[k];
    if (RATE_KEY.test(k)) { if (v !== 1) why.push(`${k} is ${JSON.stringify(v)}: only ZAR at rate 1 is imported`); continue; }
    if (/id$/i.test(k)) { if (!saysZar) why.push(`${k} ${JSON.stringify(v)} cannot be told from a foreign currency: nothing in the row says ZAR`); continue; }
    const texts = currencyTexts(v);
    if (texts.length === 0 || !texts.some(isZar)) why.push(`${k} is ${JSON.stringify(v)}: only ZAR at rate 1 is imported`);
  }
  return why;
}

/** The VAT rate of a line: its TaxPercentage and/or its TaxTypeId, checked against the rate that applied on the PO date. */
function lineRate(o: Raw, why: string[], date: string): number | undefined {
  const pct = readNumber(o, 'TaxPercentage', why, { cents: 'any' });
  const typeId = readId(o, 'TaxTypeId', why, false, true);
  if (pct === undefined || typeId === undefined) return undefined;
  const t = typeId === null ? null : taxTypeFor(typeId);
  if (typeId !== null && !t) { why.push(`TaxTypeId ${typeId} is not a tax type this migration knows (1 standard, 2 zero, 3 exempt)`); return undefined; }
  let std: number;
  try {
    std = standardRateOn(date);
  } catch (err) {
    if (!(err instanceof VatRateDateError)) throw err;
    why.push(`no VAT rate can be read for the PO date ${date}: ${err.message}`);
    return undefined;
  }
  if (pct !== null && pct !== 0 && pct !== std) {
    why.push(`TaxPercentage ${pct} is not the VAT rate on ${date} (${std}%) or 0`);
    return undefined;
  }
  const typeRate = t ? rateOf(t.vat, date) : null;
  if (pct !== null && typeRate !== null && pct !== typeRate) { why.push(`TaxPercentage ${pct} disagrees with TaxTypeId ${typeId} (${typeRate}% on ${date})`); return undefined; }
  const rate = pct ?? typeRate;
  if (rate === null) { why.push('needs TaxPercentage or TaxTypeId'); return undefined; }
  return rate;
}

/**
 * The line's type, when the export has one: ASSUMED (unconfirmed against a real export) to be Sage's PurchaseOrderLine LineType, 0 = an item
 * line, 1 = an account line. Absent or 0 is an item line, as before. 1 is refused (a SelectionId on an account line is a ledger ACCOUNT, and
 * Sage numbers entity types separately: it can equal an item's id), and any other value is refused: a line of a type nobody knows is never
 * linked to an item. The marker in the reason picks the refusal code.
 */
export const ACCOUNT_LINE_MARK = '(po_account_line_unsupported)';
export const UNKNOWN_LINE_TYPE_MARK = '(po_line_type_unknown)';
function lineTypeProblem(raw: Raw, at: string): string | null {
  const v = raw.LineType;
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  if (n === 0) return null;
  if (n === 1) {
    const account = raw.SelectionId ?? raw.ItemId;
    return `${at}LineType 1 is an account line${account === undefined || account === null ? '' : ` (account ${String(account)})`}, which this import does not read: its SelectionId is a ledger account, not an item ${ACCOUNT_LINE_MARK}`;
  }
  return `${at}LineType ${JSON.stringify(v)} is not 0 (item) or 1 (account): a line of an unknown type is never linked to an item ${UNKNOWN_LINE_TYPE_MARK}`;
}

function parseLine(raw: unknown, i: number, why: string[], date: string): SagePoLine | undefined {
  const at = `Lines[${i}].`;
  if (!isRaw(raw)) { why.push(`Lines[${i}] must be an object`); return undefined; }
  const before = why.length;
  const sub: string[] = [];
  const typeProblem = lineTypeProblem(raw, '');
  if (typeProblem) sub.push(typeProblem);
  const description = readText(raw, 'Description', 500, sub);
  const quantity = readNumber(raw, 'Quantity', sub, { required: true, positive: true });
  if (typeof quantity === 'number' && !hasWholeCents(quantity)) sub.push('Quantity has at most two decimals');
  const unit = readNumber(raw, 'UnitPriceExclusive', sub, { required: true, cents: 'any' });
  const exclusive = readNumber(raw, 'Exclusive', sub, { cents: 'whole' });
  const tax = readNumber(raw, 'Tax', sub, { cents: 'whole' });
  const rate = lineRate(raw, sub, date);
  const itemId = readId(raw, 'ItemId', sub, false, true);
  const selection = readId(raw, 'SelectionId', sub, false, true);
  if (typeof itemId === 'string' && typeof selection === 'string' && itemId !== selection) sub.push('ItemId and SelectionId name different items');
  why.push(...sub.map((s) => `${at}${s}`));
  if (why.length > before) return undefined;
  return {
    description: description as string, quantity: quantity as number, unitPriceExclusive: unit as number, taxRate: rate as number,
    exclusive: exclusive ?? null, tax: tax ?? null, itemId: (typeof itemId === 'string' ? itemId : selection) ?? null,
  };
}

export function parseSagePurchaseOrder(raw: unknown, index: number): RowResult<SagePurchaseOrder> {
  const why: string[] = [];
  const o: Raw = isRaw(raw) ? raw : {};
  if (!isRaw(raw)) why.push('the row must be an object');
  const id = readId(o, 'ID', why);
  const documentNumber = readText(o, 'DocumentNumber', 50, why);
  const date = readDate(o, 'Date', why, true);
  const deliveryDate = readDate(o, 'DeliveryDate', why, false);
  const status = readText(o, 'Status', 50, why);
  const reference = readText(o, 'Reference', 255, why, false);
  const comments = readText(o, 'Comments', 1500, why, false);
  const supplierId = readId(o, 'SupplierId', why);
  const supplierName = readText(o, 'SupplierName', 255, why, false);
  const exclusive = readNumber(o, 'Exclusive', why, { required: true, cents: 'whole' });
  const tax = readNumber(o, 'Tax', why, { required: true, cents: 'whole' });
  const total = readNumber(o, 'Total', why, { required: true, cents: 'whole' });
  const pdfFile = readText(o, 'PdfFile', 255, why, false);
  const lines: SagePoLine[] = [];
  if (!Array.isArray(o.Lines) || o.Lines.length === 0) why.push('Lines must be a non-empty array');
  else if (o.Lines.length > MAX_LINES) why.push(`Lines has ${o.Lines.length} lines; the maximum is ${MAX_LINES}`);
  else {
    // A PO whose Date cannot be read is refused anyway; its lines are read at the current rate to report their other faults.
    o.Lines.forEach((l, i) => { const line = parseLine(l, i, why, typeof date === 'string' ? date : '9999-01-01'); if (line) lines.push(line); });
  }
  if (typeof exclusive === 'number' && typeof tax === 'number' && typeof total === 'number'
    && Math.round(exclusive * 100) + Math.round(tax * 100) !== Math.round(total * 100)) {
    why.push(`Exclusive ${exclusive} + Tax ${tax} is not Total ${total}`);
  }
  const foreign = foreignCurrencyReasons(o);
  why.push(...foreign);
  if (why.length > 0) {
    return {
      ok: false,
      refusal: {
        entity: 'purchase_order', sageId: typeof id === 'string' ? id : null,
        label: typeof documentNumber === 'string' ? documentNumber : `purchase_orders[${index}]`, code: foreign.length > 0 ? 'foreign_currency' : why.some((w) => w.includes(ACCOUNT_LINE_MARK)) ? 'po_account_line_unsupported' : why.some((w) => w.includes(UNKNOWN_LINE_TYPE_MARK)) ? 'po_line_type_unknown' : why.some((w) => w.includes('(invalid_text)')) ? 'invalid_text' : 'invalid_row', reasons: why,
      },
    };
  }
  return {
    ok: true,
    value: {
      id: id as string, documentNumber: documentNumber as string, date: date as string, deliveryDate: deliveryDate ?? null,
      status: status as string, reference: reference ?? null, comments: comments ?? null, supplierId: supplierId as string,
      supplierName: supplierName ?? null, exclusive: exclusive as number, tax: tax as number, total: total as number, lines,
      pdfFile: pdfFile ?? null,
    },
  };
}
