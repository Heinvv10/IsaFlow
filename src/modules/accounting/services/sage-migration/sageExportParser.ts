/**
 * The whole export file -> accepted rows + per-row refusals. PURE (the caller reads the file).
 *
 * Container: `{ "Items": <rows>, "PurchaseOrders": <rows> }` where <rows> is an array of rows, one Sage list page
 * `{ "$resources": [...] }`, or an array of such pages. Row-level checks are in sageItemParser / sagePurchaseOrderParser;
 * here the checks that need the whole file:
 *   - an ID or a Code (item), an ID or a DocumentNumber (PO) used by more than one row refuses EVERY row that uses it;
 *   - a category ID described two ways, or two category IDs with one name (case-insensitive), refuses the later items;
 *   - a PO status outside the table refuses the PO, and so does a line naming an item the export does not contain (`line_item_unknown`)
 *     or one refused with no readable Code to name it by (`line_item_refused`). A line naming an item that is refused but has a
 *     readable code is the PLAN's business: the line goes unlinked (sageMigrationPlan).
 */
import type { ParsedExport, RowRefusal, SageCategory, SageItem, SagePurchaseOrder } from './sageExportTypes';
import { invalidTextProblem, isRaw } from './sageValues';
import { parseSageItem } from './sageItemParser';
import { parseSagePurchaseOrder } from './sagePurchaseOrderParser';
import { importStatusFor } from './sagePoStatus';

export class SageExportShapeError extends Error {}

const TOP_KEYS = ['Items', 'PurchaseOrders'];

/**
 * The rows of one top-level key: an array of rows, a page, or an array of pages. A page that says there is more than it holds
 * ($totalResults above the rows read, or a $next link) is a PARTIAL export and refuses the whole file.
 */
export function rowsOf(value: unknown, key: string): unknown[] {
  if (value === undefined || value === null) return [];
  const isPage = (p: unknown): p is Record<string, unknown> & { $resources: unknown[] } => isRaw(p) && Array.isArray(p.$resources);
  const pages: Array<Record<string, unknown> & { $resources: unknown[] }> = Array.isArray(value)
    ? (value.length > 0 && value.every(isPage) ? value as never : [])
    : isPage(value) ? [value] : [];
  if (pages.length === 0) {
    if (Array.isArray(value)) return value;
    throw new SageExportShapeError(`${key} must be an array of rows, a Sage page with $resources, or an array of pages`);
  }
  const rows = pages.flatMap((p) => p.$resources);
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  let before = 0;
  pages.forEach((p, n) => {
    if (p.$next !== undefined && p.$next !== null && p.$next !== '') throw new SageExportShapeError(`${key}: a page has a $next link, so the export stops before its end`);
    // Only the first page may lack a $back link: a page that has one is not the start of the export.
    if (n === 0 && p.$back !== undefined && p.$back !== null && p.$back !== '') throw new SageExportShapeError(`${key}: a page has a $back link, so it is not the start of the export`);
    if (p.$totalResults !== undefined && p.$totalResults !== null) {
      if (!whole(p.$totalResults)) throw new SageExportShapeError(`${key}: $totalResults must be a whole number (got ${JSON.stringify(p.$totalResults)}); it is how a partial export is told`);
      if (p.$totalResults > rows.length) throw new SageExportShapeError(`${key}: $totalResults is ${p.$totalResults} but ${rows.length} rows were read, so the export is partial`);
    }
    if (p.$startIndex !== undefined && p.$startIndex !== null) {
      if (!whole(p.$startIndex)) throw new SageExportShapeError(`${key}: $startIndex must be a whole number (got ${JSON.stringify(p.$startIndex)})`);
      if (p.$startIndex !== before) throw new SageExportShapeError(`${key}: a page starts at $startIndex ${p.$startIndex}, but ${before} rows came before it, so the export is not whole`);
    }
    before += p.$resources.length;
  });
  return rows;
}

function refuseAll<T>(rows: T[], idOf: (r: T) => string, entity: RowRefusal['entity'], labelOf: (r: T) => string,
  code: string, reason: (key: string) => string, keyOf: (r: T) => string, invalid: ReadonlyMap<string, number>): { kept: T[]; refusals: RowRefusal[] } {
  // A row that is itself invalid and carries the key counts as a row using it: Sage said two things about it, and neither is imported.
  const count = new Map<string, number>(invalid);
  for (const r of rows) count.set(keyOf(r), (count.get(keyOf(r)) ?? 0) + 1);
  const kept: T[] = [];
  const refusals: RowRefusal[] = [];
  for (const r of rows) {
    if ((count.get(keyOf(r)) ?? 0) > 1) {
      const why = reason(keyOf(r));
      refusals.push({ entity, sageId: idOf(r), label: labelOf(r), code, reasons: [(invalid.get(keyOf(r)) ?? 0) > 0 ? `${why} (another row with it is invalid)` : why] });
    }
    else kept.push(r);
  }
  return { kept, refusals };
}

function dedupe<T>(rows: T[], idOf: (r: T) => string, labelOf: (r: T) => string, entity: RowRefusal['entity'],
  checks: Array<{ code: string; key: (r: T) => string; reason: (k: string) => string; invalid: ReadonlyMap<string, number> }>): { kept: T[]; refusals: RowRefusal[] } {
  let kept = rows;
  const refusals: RowRefusal[] = [];
  for (const c of checks) {
    const out = refuseAll(kept, idOf, entity, labelOf, c.code, c.reason, c.key, c.invalid);
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
  // A misspelt or re-cased container (Purchase_Orders, items) would otherwise read as an empty one and pass as a clean export.
  const unknown = Object.keys(file).find((k) => !TOP_KEYS.includes(k));
  if (unknown !== undefined) throw new SageExportShapeError(`unknown key "${unknown}" at the top of the export (the containers are ${TOP_KEYS.join(' and ')})`);
  if ((file.Items === undefined || file.Items === null) && (file.PurchaseOrders === undefined || file.PurchaseOrders === null)) {
    throw new SageExportShapeError('the export has neither Items nor PurchaseOrders: there is nothing to import');
  }
  const itemRows = rowsOf(file.Items, 'Items');
  const poRows = rowsOf(file.PurchaseOrders, 'PurchaseOrders');
  const refusals: RowRefusal[] = [];
  const knownIds = new Set<string>();
  /** Every item row with a readable ID and Code, refused or not: what a PO line's suffix names. For a duplicated Sage id, the FIRST code seen. */
  const itemCodes: Record<string, string> = {};
  let itemsWithQuantityOnHand = 0;
  /** The ID and the readable Code or DocumentNumber of every row that is INVALID: a valid row sharing one of them is refused too. */
  const badItemIds = new Map<string, number>();
  const badItemCodes = new Map<string, number>();
  const badPoIds = new Map<string, number>();
  const badPoNumbers = new Map<string, number>();
  const note = (m: Map<string, number>, key: string | null | undefined) => { if (key) m.set(key, (m.get(key) ?? 0) + 1); };
  const readable = (raw: unknown, key: string): string | null => {
    const v = isRaw(raw) && typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
    return v !== '' && v.length <= 50 && invalidTextProblem(v) === null ? v : null;
  };

  const items: SageItem[] = [];
  itemRows.forEach((raw, i) => {
    const r = parseSageItem(raw, i);
    if (r.ok) { items.push(r.value); knownIds.add(r.value.id); itemCodes[r.value.id] ??= r.value.code; if (r.value.hadQuantityOnHand) itemsWithQuantityOnHand++; }
    else {
      refusals.push(r.refusal);
      note(badItemIds, r.refusal.sageId);
      note(badItemCodes, readable(raw, 'Code'));
      if (r.refusal.sageId) {
        knownIds.add(r.refusal.sageId);
        const code = isRaw(raw) && typeof raw.Code === 'string' ? raw.Code.trim() : '';
        if (code !== '' && code.length <= 50 && invalidTextProblem(code) === null) itemCodes[r.refusal.sageId] ??= code;
      }
    }
  });
  const uniqueItems = dedupe(items, (i) => i.id, (i) => i.code, 'item', [
    { code: 'duplicate_id', key: (i) => i.id, reason: (k) => `Sage ID ${k} is used by more than one item row`, invalid: badItemIds },
    { code: 'duplicate_code', key: (i) => i.code, reason: (k) => `Code ${k} is used by more than one item row`, invalid: badItemCodes },
  ]);
  refusals.push(...uniqueItems.refusals);
  const cats = itemCategories(uniqueItems.kept);
  refusals.push(...cats.refusals);

  const pos: SagePurchaseOrder[] = [];
  let exportPoTotalCents = 0;
  let exportRowsWithoutTotal = 0;
  poRows.forEach((raw, i) => {
    if (isRaw(raw) && typeof raw.Total === 'number' && Number.isFinite(raw.Total)) exportPoTotalCents += Math.round(raw.Total * 100);
    else exportRowsWithoutTotal++;
    const r = parseSagePurchaseOrder(raw, i);
    if (r.ok) pos.push(r.value);
    else { refusals.push(r.refusal); note(badPoIds, r.refusal.sageId); note(badPoNumbers, readable(raw, 'DocumentNumber')); }
  });
  const uniquePos = dedupe(pos, (p) => p.id, (p) => p.documentNumber, 'purchase_order', [
    { code: 'duplicate_id', key: (p) => p.id, reason: (k) => `Sage ID ${k} is used by more than one purchase order row`, invalid: badPoIds },
    { code: 'duplicate_number', key: (p) => p.documentNumber, reason: (k) => `DocumentNumber ${k} is used by more than one purchase order row`, invalid: badPoNumbers },
  ]);
  refusals.push(...uniquePos.refusals);
  const purchaseOrders: SagePurchaseOrder[] = [];
  for (const po of uniquePos.kept) {
    const reasons: string[] = [];
    if (!importStatusFor(po.status)) reasons.push(`Status "${po.status}" is not one of Pending, Overdue, Invoiced, Cancelled`);
    for (const [n, l] of po.lines.entries()) {
      if (l.itemId === null || Object.hasOwn(itemCodes, l.itemId)) continue;
      // An item with no readable code cannot be named on the line at all (the suffix needs it): refused, or not in the export.
      reasons.push(knownIds.has(l.itemId)
        ? `Lines[${n}] names item ${l.itemId}, which is refused and has no readable Code to name it by`
        : `Lines[${n}] names item ${l.itemId}, which the export does not contain`);
    }
    if (reasons.length === 0) purchaseOrders.push(po);
    else {
      const code = reasons[0]!.startsWith('Status') ? 'unknown_status' : reasons[0]!.includes('which is refused') ? 'line_item_refused' : 'line_item_unknown';
      refusals.push({ entity: 'purchase_order', sageId: po.id, label: po.documentNumber, code, reasons });
    }
  }

  return {
    categories: cats.categories, items: cats.kept, purchaseOrders, refusals, itemCodes, rowsIn: { items: itemRows.length, purchaseOrders: poRows.length },
    exportPoTotalCents, exportRowsWithoutTotal, itemsWithQuantityOnHand,
  };
}
