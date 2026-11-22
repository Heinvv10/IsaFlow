/**
 * One Sage purchase-order row -> a typed SagePurchaseOrder, or a refusal naming every fault. PURE.
 *
 * Line VAT: a line gives `TaxPercentage` and/or `TaxTypeId`. The rate is TaxPercentage when present, else the tax type's rate
 * (sageTaxTypes); both present and disagreeing is refused. A line names its item by `ItemId` (alias `SelectionId`); both
 * present and different is refused.
 */
import type { RowResult, SagePoLine, SagePurchaseOrder } from './sageExportTypes';
import { isRaw, readDate, readId, readNumber, readText, type Raw } from './sageValues';
import { VatRateDateError } from '@/lib/vat/standardRate';
import { rateOf, standardRateOn, taxTypeFor } from './sageTaxTypes';

const MAX_LINES = 200;

/** The VAT rate of a line: its TaxPercentage and/or its TaxTypeId, checked against the rate that applied on the PO date. */
function lineRate(o: Raw, why: string[], date: string): number | undefined {
  const pct = readNumber(o, 'TaxPercentage', why, { cents: 'any' });
  const typeId = readId(o, 'TaxTypeId', why, false);
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

function parseLine(raw: unknown, i: number, why: string[], date: string): SagePoLine | undefined {
  const at = `Lines[${i}].`;
  if (!isRaw(raw)) { why.push(`Lines[${i}] must be an object`); return undefined; }
  const before = why.length;
  const sub: string[] = [];
  const description = readText(raw, 'Description', 500, sub);
  const quantity = readNumber(raw, 'Quantity', sub, { required: true, positive: true });
  if (typeof quantity === 'number' && Math.abs(quantity * 100 - Math.round(quantity * 100)) > 1e-6) sub.push('Quantity has at most two decimals');
  const unit = readNumber(raw, 'UnitPriceExclusive', sub, { required: true, cents: 'any' });
  const exclusive = readNumber(raw, 'Exclusive', sub, { cents: 'whole' });
  const tax = readNumber(raw, 'Tax', sub, { cents: 'whole' });
  const rate = lineRate(raw, sub, date);
  const itemId = readId(raw, 'ItemId', sub, false);
  const selection = readId(raw, 'SelectionId', sub, false);
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
  if (why.length > 0) {
    return {
      ok: false,
      refusal: {
        entity: 'purchase_order', sageId: typeof id === 'string' ? id : null,
        label: typeof documentNumber === 'string' ? documentNumber : `purchase_orders[${index}]`, code: 'invalid_row', reasons: why,
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
