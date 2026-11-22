/**
 * The whole export file -> accepted rows + per-row refusals. PURE (the caller reads the file).
 *
 * Container: `{ "Items": <rows>, "PurchaseOrders": <rows> }` where <rows> is an array of rows, one Sage list page
 * `{ "$resources": [...] }`, or an array of such pages. Row-level checks are in sageItemParser / sagePurchaseOrderParser;
 * here the checks that need the whole file:
 *   - an ID or a Code (item), an ID or a DocumentNumber (PO) used by more than one row refuses EVERY row that uses it;
 *   - a category ID described two ways, or two category IDs with one name (case-insensitive), refuses the later items;
 *   - a PO status outside the table, and a PO line naming an item ID the export does not contain, refuse the PO.
 */
import type { ParsedExport, RowRefusal, SageCategory, SageItem, SagePurchaseOrder } from './sageExportTypes';
import { isRaw } from './sageValues';
import { parseSageItem } from './sageItemParser';
import { parseSagePurchaseOrder } from './sagePurchaseOrderParser';
import { importStatusFor } from './sagePoStatus';

export class SageExportShapeError extends Error {}

/** The rows of one top-level key: an array of rows, a page, or an array of pages. */
export function rowsOf(value: unknown, key: string): unknown[] {
  if (value === undefined || value === null) return [];
  const pages = Array.isArray(value) && value.length > 0 && value.every((p) => isRaw(p) && Array.isArray(p.$resources));
  if (pages) return (value as Array<{ $resources: unknown[] }>).flatMap((p) => p.$resources);
  if (Array.isArray(value)) return value;
  if (isRaw(value) && Array.isArray(value.$resources)) return value.$resources;
  throw new SageExportShapeError(`${key} must be an array of rows, a Sage page with $resources, or an array of pages`);
}

function refuseAll<T>(rows: T[], idOf: (r: T) => string, entity: RowRefusal['entity'], labelOf: (r: T) => string,
  code: string, reason: (key: string) => string, keyOf: (r: T) => string): { kept: T[]; refusals: RowRefusal[] } {
  const count = new Map<string, number>();
  for (const r of rows) count.set(keyOf(r), (count.get(keyOf(r)) ?? 0) + 1);
  const kept: T[] = [];
  const refusals: RowRefusal[] = [];
  for (const r of rows) {
    if ((count.get(keyOf(r)) ?? 0) > 1) refusals.push({ entity, sageId: idOf(r), label: labelOf(r), code, reasons: [reason(keyOf(r))] });
    else kept.push(r);
  }
  return { kept, refusals };
}

function dedupe<T>(rows: T[], idOf: (r: T) => string, labelOf: (r: T) => string, entity: RowRefusal['entity'],
  checks: Array<{ code: string; key: (r: T) => string; reason: (k: string) => string }>): { kept: T[]; refusals: RowRefusal[] } {
  let kept = rows;
  const refusals: RowRefusal[] = [];
  for (const c of checks) {
    const out = refuseAll(kept, idOf, entity, labelOf, c.code, c.reason, c.key);
    kept = out.kept;
    refusals.push(...out.refusals);
  }
  return { kept, refusals };
}

function itemCategories(items: SageItem[]): { kept: SageItem[]; categories: SageCategory[]; refusals: RowRefusal[] } {
  const byId = new Map<string, SageCategory>();
  const idByName = new Map<string, string>();
  const kept: SageItem[] = [];
  const refusals: RowRefusal[] = [];
  const refuse = (i: SageItem, code: string, reason: string) => refusals.push({ entity: 'item', sageId: i.id, label: i.code, code, reasons: [reason] });
  for (const item of items) {
    const c = item.category;
    if (!c) { kept.push(item); continue; }
    const known = byId.get(c.id);
    if (known) {
      if (known.description !== c.description) { refuse(item, 'category_description_conflict', `category ${c.id} is "${c.description}" here and "${known.description}" on an earlier item`); continue; }
      kept.push(item);
      continue;
    }
    const owner = idByName.get(c.description.toLowerCase());
    if (owner !== undefined && owner !== c.id) { refuse(item, 'category_name_collision', `categories ${owner} and ${c.id} share the name "${c.description}"; IsaFlow categories have unique names`); continue; }
    byId.set(c.id, c);
    idByName.set(c.description.toLowerCase(), c.id);
    kept.push(item);
  }
  return { kept, categories: [...byId.values()], refusals };
}

export function parseSageExport(file: unknown): ParsedExport {
  if (!isRaw(file)) throw new SageExportShapeError('the export must be a JSON object with Items and/or PurchaseOrders');
  const itemRows = rowsOf(file.Items, 'Items');
  const poRows = rowsOf(file.PurchaseOrders, 'PurchaseOrders');
  const refusals: RowRefusal[] = [];
  const codeById = new Map<string, string>();
  let itemsWithQuantityOnHand = 0;

  const items: SageItem[] = [];
  itemRows.forEach((raw, i) => {
    const r = parseSageItem(raw, i);
    if (r.ok) { items.push(r.value); codeById.set(r.value.id, r.value.code); if (r.value.hadQuantityOnHand) itemsWithQuantityOnHand++; }
    else {
      refusals.push(r.refusal);
      if (r.refusal.sageId && isRaw(raw) && typeof raw.Code === 'string') codeById.set(r.refusal.sageId, raw.Code.trim());
    }
  });
  const uniqueItems = dedupe(items, (i) => i.id, (i) => i.code, 'item', [
    { code: 'duplicate_id', key: (i) => i.id, reason: (k) => `Sage ID ${k} is used by more than one item row` },
    { code: 'duplicate_code', key: (i) => i.code, reason: (k) => `Code ${k} is used by more than one item row` },
  ]);
  refusals.push(...uniqueItems.refusals);
  const cats = itemCategories(uniqueItems.kept);
  refusals.push(...cats.refusals);

  const pos: SagePurchaseOrder[] = [];
  let exportPoTotalCents = 0;
  poRows.forEach((raw, i) => {
    if (isRaw(raw) && typeof raw.Total === 'number' && Number.isFinite(raw.Total)) exportPoTotalCents += Math.round(raw.Total * 100);
    const r = parseSagePurchaseOrder(raw, i);
    if (r.ok) pos.push(r.value); else refusals.push(r.refusal);
  });
  const uniquePos = dedupe(pos, (p) => p.id, (p) => p.documentNumber, 'purchase_order', [
    { code: 'duplicate_id', key: (p) => p.id, reason: (k) => `Sage ID ${k} is used by more than one purchase order row` },
    { code: 'duplicate_number', key: (p) => p.documentNumber, reason: (k) => `DocumentNumber ${k} is used by more than one purchase order row` },
  ]);
  refusals.push(...uniquePos.refusals);
  const purchaseOrders: SagePurchaseOrder[] = [];
  for (const po of uniquePos.kept) {
    const reasons: string[] = [];
    if (!importStatusFor(po.status)) reasons.push(`Status "${po.status}" is not one of Pending, Overdue, Invoiced, Cancelled`);
    for (const [n, l] of po.lines.entries()) {
      if (l.itemId !== null && !codeById.has(l.itemId)) reasons.push(`Lines[${n}] names item ${l.itemId}, which the export does not contain`);
    }
    if (reasons.length === 0) purchaseOrders.push(po);
    else refusals.push({ entity: 'purchase_order', sageId: po.id, label: po.documentNumber, code: reasons[0]!.startsWith('Status') ? 'unknown_status' : 'line_item_unknown', reasons });
  }

  return {
    categories: cats.categories, items: cats.kept, purchaseOrders, refusals, itemCodes: Object.fromEntries(codeById), rowsIn: { items: itemRows.length, purchaseOrders: poRows.length },
    exportPoTotalCents, itemsWithQuantityOnHand,
  };
}
