/**
 * The parsed export + the supplier resolutions + what the company already holds -> what is sent, and what is refused before
 * sending. PURE.
 *
 * A row the tools' own pure validators would refuse (validateItemFields for an item, parsePurchaseOrder for a PO: field rules,
 * line amounts, the expected totals to the cent) is refused HERE with the tool's reason, so one bad row costs that row and not
 * the 500 or 100 around it (the tools refuse a whole batch for one bad row). The same goes for what the company already holds
 * (`Existing`): an item code another item carries, a deleted item, a PO number another PO carries. Only a budget block, or a
 * race with another writer, can still fail a batch, and the report says so.
 * Code and number uniqueness are case-SENSITIVE (the unique indexes are on the plain columns), so the match is exact.
 */
import type { ParsedExport, RowRefusal } from './sageExportTypes';
import { mapSageCategory, mapSageItem } from './sageItemMapping';
import { mapSagePurchaseOrder } from './sagePurchaseOrderMapping';
import type { SupplierResolution } from './sageSuppliers';
import { byStableKey } from './sageBatches';
import { SAGE_SYSTEM } from './sageItemMapping';
import type { ExistingItem, Snapshot } from './sageSnapshot';
import { validateItemFields } from '@/modules/accounting/services/items/itemFieldValidation';
import { parsePurchaseOrder } from '@/lib/mcp/tools/purchaseOrderImportArgs';

export interface PlannedItem { sageId: string; row: Record<string, unknown> }
export interface PlannedPo { sageId: string; documentNumber: string; totalCents: number; element: Record<string, unknown>; pdfFile: string | null }

export interface MigrationPlan {
  categories: Array<Record<string, unknown>>;
  items: PlannedItem[];
  purchaseOrders: PlannedPo[];
  refusals: RowRefusal[];
}

export type Existing = Pick<Snapshot, 'items' | 'poNumbers'>;

/** Why the item tool would refuse `sageId`/`code` against what the company holds, or null (it mirrors itemUpsertPlan). */
function itemConflict(sageId: string, code: string, items: readonly ExistingItem[]): { code: string; reason: string } | null {
  const byRef = items.find((i) => i.system === SAGE_SYSTEM && i.ref === sageId);
  const byCode = items.find((i) => i.code === code);
  const held = (i: ExistingItem) => `item ${i.code} (${i.system ?? 'no system'} ${i.ref ?? 'no reference'})`;
  if (byRef && byCode && byRef.id !== byCode.id) {
    return { code: 'ref_code_conflict', reason: `Sage id ${sageId} is already ${held(byRef)} and code ${code} belongs to a different item, ${held(byCode)}` };
  }
  if (!byRef && byCode && byCode.ref !== null) {
    return { code: 'code_in_use_by_other_ref', reason: `code ${code} already belongs to ${held(byCode)}, an item with another external reference` };
  }
  const match = byRef ?? byCode;
  if (match?.deleted) return { code: 'item_deleted', reason: `the matching ${held(match)} has been deleted` };
  return null;
}

export function planMigration(parsed: ParsedExport, suppliers: ReadonlyMap<string, SupplierResolution>, existing: Existing, opts: { poGlAccountId?: string } = {}): MigrationPlan {
  const refusals: RowRefusal[] = [...parsed.refusals];

  const items: PlannedItem[] = [];
  /** The items that will really be sent: the only ones a PO line may name. */
  const sentCodes: Record<string, string> = {};
  const usedCategories = new Set<string>();
  for (const item of byStableKey(parsed.items, (i) => i.id)) {
    const conflict = itemConflict(item.id, item.code, existing.items);
    if (conflict) { refusals.push({ entity: 'item', sageId: item.id, label: item.code, code: conflict.code, reasons: [conflict.reason] }); continue; }
    const row = mapSageItem(item);
    const checked = validateItemFields(row);
    if (!checked.ok) {
      refusals.push({ entity: 'item', sageId: item.id, label: item.code, code: 'tool_refuses', reasons: [`${checked.code}: ${checked.reason}`] });
      continue;
    }
    items.push({ sageId: item.id, row });
    sentCodes[item.id] = item.code;
    if (item.category) usedCategories.add(item.category.id);
  }
  // Only categories an item that is being sent uses.
  const categories = byStableKey(parsed.categories.filter((c) => usedCategories.has(c.id)), (c) => c.id).map(mapSageCategory);

  const purchaseOrders: PlannedPo[] = [];
  for (const po of byStableKey(parsed.purchaseOrders, (p) => p.id)) {
    const supplier = suppliers.get(po.supplierId);
    const refuse = (code: string, reason: string) => refusals.push({ entity: 'purchase_order', sageId: po.id, label: po.documentNumber, code, reasons: [reason] });
    if (!supplier) { refuse('supplier_unresolved', `supplier ${po.supplierId} was not looked up`); continue; }
    if (!('id' in supplier)) { refuse(supplier.code, supplier.reason); continue; }
    const unsent = po.lines.find((l) => l.itemId !== null && !Object.hasOwn(sentCodes, l.itemId));
    if (unsent) { refuse('line_item_refused', `a line names item ${unsent.itemId}, which is refused and so is not imported`); continue; }
    const holder = existing.poNumbers.get(po.documentNumber);
    if (holder && !(holder.system === SAGE_SYSTEM && holder.ref === po.id)) {
      refuse('po_number_taken', `${po.documentNumber} already belongs to a purchase order (${holder.ref ? `${holder.system} ${holder.ref}` : 'no external reference'}); the tool would refuse the whole batch`);
      continue;
    }
    const element = mapSagePurchaseOrder(po, supplier.id, sentCodes, opts.poGlAccountId);
    const checked = parsePurchaseOrder(element, 0);
    if (typeof checked === 'string') { refuse('tool_refuses', checked); continue; }
    purchaseOrders.push({ sageId: po.id, documentNumber: po.documentNumber, totalCents: checked.totals.total, element, pdfFile: po.pdfFile });
  }
  return { categories, items, purchaseOrders, refusals };
}
