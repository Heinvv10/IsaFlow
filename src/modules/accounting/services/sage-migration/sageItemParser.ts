/**
 * One Sage item row -> a typed SageItem, or a refusal naming every fault. PURE.
 *
 * HARD RULE (Hein): `QuantityOnHand` is read for one thing only, to know the row had one (the report counts them). Its value
 * is not stored on SageItem, so nothing downstream can import it as opening stock.
 */
import type { RowResult, SageItem } from './sageExportTypes';
import { isRaw, readBool, readId, readNumber, readText, type Raw } from './sageValues';
import { taxTypeFor } from './sageTaxTypes';

function taxField(o: Raw, key: string, why: string[]): SageItem['taxSales'] | undefined {
  const id = readId(o, key, why, false);
  if (id === undefined) return undefined;
  if (id === null) return null;
  const t = taxTypeFor(id);
  if (!t) { why.push(`${key} ${id} is not a tax type this migration knows (1 standard, 2 zero, 3 exempt)`); return undefined; }
  return t.vat;
}

function category(o: Raw, why: string[]): SageItem['category'] | undefined {
  const c = o.Category;
  if (c === undefined || c === null) return null;
  if (!isRaw(c)) { why.push('Category must be an object {ID, Description} or null'); return undefined; }
  const before = why.length;
  const id = readId(c, 'ID', why);
  const description = readText(c, 'Description', 255, why);
  if (why.length > before) { why.splice(before, why.length - before, 'Category needs both ID and Description'); return undefined; }
  return { id: id as string, description: description as string };
}

export function parseSageItem(raw: unknown, index: number): RowResult<SageItem> {
  const why: string[] = [];
  const o: Raw = isRaw(raw) ? raw : {};
  if (!isRaw(raw)) why.push('the row must be an object');
  const id = readId(o, 'ID', why);
  const code = readText(o, 'Code', 50, why);
  const description = readText(o, 'Description', 255, why);
  const active = readBool(o, 'Active', why);
  const physical = readBool(o, 'Physical', why);
  const priceExclusive = readNumber(o, 'PriceExclusive', why, { cents: 'round' });
  const lastCost = readNumber(o, 'LastCost', why, { cents: 'round' });
  const averageCost = readNumber(o, 'AverageCost', why, { cents: 'round' });
  const taxSales = taxField(o, 'TaxTypeIdSales', why);
  const taxPurchases = taxField(o, 'TaxTypeIdPurchases', why);
  const cat = category(o, why);
  if (o.QuantityOnHand !== undefined && o.QuantityOnHand !== null && typeof o.QuantityOnHand !== 'number') {
    why.push('QuantityOnHand must be a number when present (it is ignored, but a malformed row is not trusted)');
  }
  if (why.length > 0) {
    return {
      ok: false,
      refusal: {
        entity: 'item', sageId: typeof id === 'string' ? id : null,
        label: typeof code === 'string' ? code : `items[${index}]`, code: 'invalid_row', reasons: why,
      },
    };
  }
  return {
    ok: true,
    value: {
      id: id as string, code: code as string, description: description as string, active: active as boolean,
      physical: physical as boolean, priceExclusive: priceExclusive ?? null, lastCost: lastCost ?? null,
      averageCost: averageCost ?? null, taxSales: taxSales ?? null, taxPurchases: taxPurchases ?? null, category: cat ?? null,
      hadQuantityOnHand: typeof o.QuantityOnHand === 'number',
    },
  };
}
