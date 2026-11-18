/**
 * The decision half of `bulk_upsert_items` / `update_item`: given validated rows and what the company already holds,
 * say per row `created`, `updated` or `unchanged` (with exactly which fields change), or refuse it. PURE — it reads
 * nothing and writes nothing, so a dry run and a live call cannot disagree: both run this, and only the live one then
 * applies what it returns.
 *
 * MATCHING (bulk). An external reference (system + ref) is the identity; the code is the fallback.
 *   - ref and code each find an item, and they are different items -> refused (ref_code_conflict);
 *   - the code finds an item that already carries a DIFFERENT reference -> refused (code_in_use_by_other_ref);
 *   - otherwise the ref's item, else the code's item, else a new item.
 * Two rows that address the same item, the same code or the same reference are refused after the first.
 *
 * UNCHANGED. A field the row names is compared with the stored value (money in whole cents); a field it omits is kept
 * on an existing item, so a re-run of identical input is `unchanged` for every row and writes nothing.
 */
import type { ItemRefusal } from './itemCatalogTypes';
import type { ItemFields } from './itemFieldValidation';
import { refKey, type ExistingItem, type UpsertContext } from './itemUpsertContext';

export type ItemOutcome = 'created' | 'updated' | 'unchanged';

/** Columns of `items` a plan writes. On an update only the changed ones are present. */
export interface ItemColumnValues {
  code?: string;
  description?: string;
  item_type?: string;
  unit?: string;
  category_id?: string;
  cost_price?: number;
  selling_price_excl?: number;
  vat_on_sales?: string;
  vat_on_purchases?: string;
  sales_account_id?: string;
  purchases_account_id?: string;
  inventory_tracked?: boolean;
  is_active?: boolean;
  notes?: string;
  external_system?: string;
  external_ref?: string;
  external_document_number?: string;
}

export interface PlannedItemRow {
  index: number;
  outcome: ItemOutcome;
  /** The matched item; null for a row that creates one. */
  itemId: string | null;
  code: string;
  /** Wire names of the fields that change (every named field, on a create). */
  changed: string[];
  values: ItemColumnValues;
}

export interface PlanInputRow {
  index: number;
  fields: ItemFields;
  /** update_item: the item the caller named by id. Absent in a bulk upsert, which matches by reference then code. */
  targetId?: string;
}

export interface ItemPlan {
  planned: PlannedItemRow[];
  refusals: ItemRefusal[];
}

type Resolved = { id: string | null } | { refusal: { code: string; reason: string } };

function resolveCategory(f: ItemFields, ctx: UpsertContext): Resolved {
  if (f.categoryId === undefined && f.categoryCode === undefined && f.categoryName === undefined) return { id: null };
  let hits = ctx.categories;
  if (f.categoryId !== undefined) hits = hits.filter((c) => c.id === f.categoryId);
  else if (f.categoryCode !== undefined) hits = hits.filter((c) => c.code === f.categoryCode);
  else hits = hits.filter((c) => c.name.toLowerCase() === (f.categoryName as string).toLowerCase());
  if (hits.length === 0) return { refusal: { code: 'category_not_found', reason: 'the category does not exist (categories are never created implicitly; use upsert_item_category first)' } };
  if (hits.length > 1) return { refusal: { code: 'category_ambiguous', reason: 'more than one category matches that name; send category_id or category_code' } };
  return { id: hits[0]!.id };
}

const cents = (n: number): number => Math.round(n * 100);

interface Field {
  wire: string;
  column: keyof ItemColumnValues;
  next: string | number | boolean | undefined;
  old: (m: ExistingItem) => string | number | boolean | null;
  money?: boolean;
}

function fieldsOf(f: ItemFields, categoryId: string | null): Field[] {
  return [
    { wire: 'code', column: 'code', next: f.code, old: (m) => m.code },
    { wire: 'description', column: 'description', next: f.description, old: (m) => m.description },
    { wire: 'item_type', column: 'item_type', next: f.itemType, old: (m) => m.itemType },
    { wire: 'unit', column: 'unit', next: f.unit, old: (m) => m.unit },
    { wire: 'category', column: 'category_id', next: categoryId ?? undefined, old: (m) => m.categoryId },
    { wire: 'purchase_price', column: 'cost_price', next: f.purchasePrice, old: (m) => m.purchasePrice, money: true },
    { wire: 'sales_price', column: 'selling_price_excl', next: f.salesPrice, old: (m) => m.salesPrice, money: true },
    { wire: 'vat_on_sales', column: 'vat_on_sales', next: f.vatOnSales, old: (m) => m.vatOnSales },
    { wire: 'vat_on_purchases', column: 'vat_on_purchases', next: f.vatOnPurchases, old: (m) => m.vatOnPurchases },
    { wire: 'sales_account_id', column: 'sales_account_id', next: f.salesAccountId, old: (m) => m.salesAccountId },
    { wire: 'purchases_account_id', column: 'purchases_account_id', next: f.purchasesAccountId, old: (m) => m.purchasesAccountId },
    { wire: 'inventory_tracked', column: 'inventory_tracked', next: f.inventoryTracked, old: (m) => m.inventoryTracked },
    { wire: 'is_active', column: 'is_active', next: f.isActive, old: (m) => m.isActive },
    { wire: 'notes', column: 'notes', next: f.notes, old: (m) => m.notes },
    { wire: 'external_system', column: 'external_system', next: f.externalSystem, old: (m) => m.externalSystem },
    { wire: 'external_ref', column: 'external_ref', next: f.externalRef, old: (m) => m.externalRef },
    { wire: 'external_document_number', column: 'external_document_number', next: f.externalDocumentNumber, old: (m) => m.externalDocumentNumber },
  ];
}

const same = (fl: Field, m: ExistingItem): boolean => {
  const o = fl.old(m);
  return fl.money ? o !== null && cents(o as number) === cents(fl.next as number) : o === fl.next;
};

const CREATE_DEFAULTS = { item_type: 'physical', unit: 'each', vat_on_sales: 'standard', vat_on_purchases: 'standard' } as const;

type Bad = { code: string; reason: string } | null;

/** The default GL accounts a row names must be this company's and active. */
function accountRefusal(v: ItemColumnValues, ctx: UpsertContext): Bad {
  for (const [col, id] of [['sales_account_id', v.sales_account_id], ['purchases_account_id', v.purchases_account_id]] as const) {
    if (id === undefined) continue;
    const active = ctx.accounts.get(id);
    if (active === undefined) return { code: 'account_not_found', reason: `${col} is not an account of this company` };
    if (!active) return { code: 'account_inactive', reason: `${col} is an inactive account` };
  }
  return null;
}

function trackedRefusal(itemType: string, tracked: boolean): Bad {
  return itemType === 'service' && tracked
    ? { code: 'service_cannot_be_tracked', reason: 'a service is never stock: send inventory_tracked false (or item_type physical)' }
    : null;
}

export function planItemRows(rows: PlanInputRow[], ctx: UpsertContext): ItemPlan {
  const planned: PlannedItemRow[] = [];
  const refusals: ItemRefusal[] = [];
  const seenCodes = new Map<string, number>();
  const seenRefs = new Map<string, number>();
  const targeted = new Map<string, number>();

  for (const { index, fields: f, targetId } of rows) {
    const refuse = (code: string, reason: string): void => { refusals.push({ index, code, reason }); };
    const key = f.externalSystem && f.externalRef ? refKey(f.externalSystem, f.externalRef) : null;

    if (!targetId && !f.code) { refuse('code_required', 'code is required'); continue; }
    if (f.code) {
      const first = seenCodes.get(f.code);
      if (first !== undefined) { refuse('duplicate_in_request', `code ${f.code} already appears in row ${first}`); continue; }
      seenCodes.set(f.code, index);
    }
    if (key) {
      const first = seenRefs.get(key);
      if (first !== undefined) { refuse('duplicate_in_request', `external_ref ${f.externalRef} already appears in row ${first}`); continue; }
      seenRefs.set(key, index);
    }

    const refHit = key ? ctx.byRef.get(key) : undefined;
    const codeHit = f.code ? ctx.byCode.get(f.code) : undefined;
    let match: ExistingItem | undefined;
    if (targetId) {
      match = ctx.byId.get(targetId);
      if (!match) { refuse('item_not_found', 'no such item'); continue; }
      if (codeHit && codeHit.id !== match.id) { refuse('code_in_use', `code ${f.code} belongs to another item`); continue; }
      if (refHit && refHit.id !== match.id) { refuse('external_ref_in_use', 'that external reference belongs to another item'); continue; }
    } else {
      if (refHit && codeHit && refHit.id !== codeHit.id) {
        refuse('ref_code_conflict', `external_ref ${f.externalRef} and code ${f.code} belong to two different items`);
        continue;
      }
      if (!refHit && codeHit && key && codeHit.externalRef && (codeHit.externalSystem !== f.externalSystem || codeHit.externalRef !== f.externalRef)) {
        refuse('code_in_use_by_other_ref', `code ${f.code} already belongs to an item with a different external reference`);
        continue;
      }
      match = refHit ?? codeHit;
    }
    if (match?.deleted) { refuse('item_deleted', 'the matching item has been deleted'); continue; }
    if (match) {
      const prior = targeted.get(match.id);
      if (prior !== undefined) { refuse('duplicate_in_request', `row ${prior} already addresses this item`); continue; }
      targeted.set(match.id, index);
    }

    const category = resolveCategory(f, ctx);
    if ('refusal' in category) { refuse(category.refusal.code, category.refusal.reason); continue; }
    const all = fieldsOf(f, category.id);
    const named = all.filter((x) => x.next !== undefined);

    if (!match) {
      if (!f.description) { refuse('description_required', 'description is required to create an item'); continue; }
      const values: ItemColumnValues = {};
      for (const fl of named) (values as Record<string, unknown>)[fl.column] = fl.next;
      const withDefaults: ItemColumnValues = { ...CREATE_DEFAULTS, cost_price: 0, selling_price_excl: 0, inventory_tracked: false, is_active: true, ...values };
      if (category.id && ctx.categories.find((c) => c.id === category.id)?.isActive === false) {
        refuse('category_inactive', 'the category is inactive'); continue;
      }
      if (f.externalDocumentNumber && !f.externalRef) {
        refuse('invalid_field', 'external_document_number needs an external_ref (send external_system and external_ref)'); continue;
      }
      const bad = accountRefusal(withDefaults, ctx)
        ?? trackedRefusal(withDefaults.item_type as string, withDefaults.inventory_tracked === true);
      if (bad) { refuse(bad.code, bad.reason); continue; }
      planned.push({ index, outcome: 'created', itemId: null, code: f.code as string, changed: named.map((x) => x.wire), values: withDefaults });
      continue;
    }

    const diff = named.filter((fl) => !same(fl, match));
    const values: ItemColumnValues = {};
    for (const fl of diff) (values as Record<string, unknown>)[fl.column] = fl.next;
    if (diff.length === 0) {
      planned.push({ index, outcome: 'unchanged', itemId: match.id, code: match.code, changed: [], values });
      continue;
    }
    if (values.category_id && ctx.categories.find((c) => c.id === values.category_id)?.isActive === false) {
      refuse('category_inactive', 'the category is inactive'); continue;
    }
    if (values.item_type === 'service' && match.itemType !== 'service' && ctx.itemsWithMovements.has(match.id)) {
      refuse('has_stock_movements', 'an item with stock movements cannot become a service'); continue;
    }
    const typeOrTrackedChanged = values.item_type !== undefined || values.inventory_tracked !== undefined;
    const bad = accountRefusal(values, ctx)
      ?? (typeOrTrackedChanged ? trackedRefusal(values.item_type ?? match.itemType, values.inventory_tracked ?? match.inventoryTracked) : null);
    if (bad) { refuse(bad.code, bad.reason); continue; }
    if (!match.externalRef && !values.external_ref && values.external_document_number !== undefined) {
      refuse('invalid_field', 'external_document_number needs an external_ref (send external_system and external_ref)'); continue;
    }
    planned.push({ index, outcome: 'updated', itemId: match.id, code: values.code ?? match.code, changed: diff.map((x) => x.wire), values });
  }
  return { planned, refusals };
}
