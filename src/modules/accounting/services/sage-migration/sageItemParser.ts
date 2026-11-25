/**
 * One Sage item row -> a typed SageItem, or a refusal naming every fault. PURE.
 *
 * HARD RULE (Hein): `QuantityOnHand` is read for one thing only, to know the row had a numeric one (the report counts them; any other
 * value is ignored like the field itself, not a reason to refuse the item). Its value
 * is not stored on SageItem, so nothing downstream can import it as opening stock.
 */
import type { RowResult, SageItem } from './sageExportTypes';
import { isRaw, readBool, readId, readNumber, readText, recasedFieldReasons, SAGE_NONE_UNKNOWN, type Raw } from './sageValues';
import { taxTypeFor } from './sageTaxTypes';
import { discountReasons, ITEM_DISCOUNT_MARK } from './sageMoneyFields';

/** The fields of an item row this import reads (QuantityOnHand only for the count): any other spelling of one is refused. */
const ITEM_FIELDS = ['ID', 'Code', 'Description', 'Active', 'Physical', 'PriceExclusive', 'LastCost', 'AverageCost', 'TaxTypeIdSales', 'TaxTypeIdPurchases', 'Category', 'QuantityOnHand'] as const;
/** The fields of a Category object this import reads. */
const CATEGORY_FIELDS = ['ID', 'Description'] as const;

function taxField(o: Raw, key: string, why: string[]): SageItem['taxSales'] | undefined {
  const id = readId(o, key, why, false, true);
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
  // A Category field in another spelling ({ id: 7 } beside ID, { Id: 5 }) is refused, never ignored (B12-6), and said so.
  const respelled = recasedFieldReasons(c, CATEGORY_FIELDS).map((w) => `Category.${w}`);
  if (respelled.length > 0) { why.push(...respelled); return undefined; }
  const before = why.length;
  const id = readId(c, 'ID', why, true, true);
  const description = readText(c, 'Description', 255, why);
  if (why.length > before) {
    // An invalid_text fault keeps its own reason (it names the field); any other fault is "needs both".
    if (!why.slice(before).some((w) => w.includes('(invalid_text)'))) {
      // A Description of '' and one of blanks are the same question (readText trims both to nothing).
      const blankDescription = typeof c.Description === 'string' && c.Description.trim() === '';
      const none = Object.keys(c).length === 0 || why.slice(before).some((w) => w.includes(SAGE_NONE_UNKNOWN)) || blankDescription;
      why.splice(before, why.length - before, none ? `Category is an empty object, has an ID of 0 or "", or an empty Description: ${SAGE_NONE_UNKNOWN}; give both ID and Description, or null for no category` : 'Category needs both ID and Description');
    }
    else why.splice(before, why.length - before, ...why.slice(before).map((w) => `Category.${w}`));
    return undefined;
  }
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
  const priceExclusive = readNumber(o, 'PriceExclusive', why, { cents: 'whole' });
  const lastCost = readNumber(o, 'LastCost', why, { cents: 'round' });
  const averageCost = readNumber(o, 'AverageCost', why, { cents: 'round' });
  const taxSales = taxField(o, 'TaxTypeIdSales', why);
  const taxPurchases = taxField(o, 'TaxTypeIdPurchases', why);
  const cat = category(o, why);
  why.push(...recasedFieldReasons(o, ITEM_FIELDS), ...discountReasons(o, ITEM_DISCOUNT_MARK));
  if (why.length > 0) {
    return {
      ok: false,
      refusal: {
        entity: 'item', sageId: typeof id === 'string' ? id : null,
        label: typeof code === 'string' ? code : `items[${index}]`, code: why.some((w) => w.includes(ITEM_DISCOUNT_MARK)) ? 'item_discount_unsupported' : why.some((w) => w.includes('(invalid_text)')) ? 'invalid_text' : 'invalid_row', reasons: why,
      },
    };
  }
  return {
    ok: true,
    value: {
      id: id as string, code: code as string, description: description as string, active: active as boolean,
      physical: physical as boolean, priceExclusive: priceExclusive ?? null, lastCost: lastCost ?? null,
      averageCost: averageCost ?? null, taxSales: taxSales ?? null, taxPurchases: taxPurchases ?? null, category: cat ?? null,
      hadQuantityOnHand: o.QuantityOnHand !== undefined && o.QuantityOnHand !== null,
    },
  };
}
