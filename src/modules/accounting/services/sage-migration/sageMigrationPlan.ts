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
import { MAX_LINE_DESCRIPTION, mapSagePurchaseOrder } from './sagePurchaseOrderMapping';
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

export type Existing = Pick<Snapshot, 'items' | 'categories' | 'poNumbers' | 'budgetPolicy'>;

/**
 * Why `sageId`/`code` must not be sent, or null. bulk_upsert_items matches by Sage reference and then by CODE, and updates what it
 * matches: a Sage item whose code equals an item IsaFlow already holds would overwrite it (a tracked item with stock turned into
 * an untracked service, a live item deactivated). So the migration only ever updates an item it owns (system sage, this id):
 * a code held by any other item, with or without an external reference, deleted or not, is refused and the item named.
 */
function itemConflict(sageId: string, code: string, items: readonly ExistingItem[]): { code: string; reason: string } | null {
  const byRef = items.find((i) => i.system === SAGE_SYSTEM && i.ref === sageId);
  const byCode = items.find((i) => i.code === code);
  const held = (i: ExistingItem) => `item ${i.code} (id ${i.id}, ${i.ref ? `${i.system ?? 'no system'} ${i.ref}` : 'no external reference'}${i.deleted ? ', deleted' : ''})`;
  if (byRef && byCode && byRef.id !== byCode.id) {
    return { code: 'ref_code_conflict', reason: `Sage id ${sageId} is already ${held(byRef)} and code ${code} belongs to a different item, ${held(byCode)}` };
  }
  if (byCode && byCode.id !== byRef?.id) {
    return { code: 'code_held_by_existing_item', reason: `code ${code} is held by ${held(byCode)}, which this migration does not own: an item it did not import is never updated` };
  }
  if (byRef?.deleted) return { code: 'item_deleted', reason: `the matching ${held(byRef)} has been deleted` };
  return null;
}

export function planMigration(parsed: ParsedExport, suppliers: ReadonlyMap<string, SupplierResolution>, existing: Existing, opts: { poGlAccountId?: string; skipBudgetCheck?: boolean } = {}): MigrationPlan {
  const refusals: RowRefusal[] = [...parsed.refusals];

  // A category whose name another IsaFlow category (not this Sage category) holds: the category tool would refuse it (name_in_use) and
  // with it the whole batch of items, so the category and the items in it are refused here, one reason each.
  const refusedCategories = new Map<string, string>();
  for (const c of parsed.categories) {
    const holder = existing.categories.find((x) => x.name.toLowerCase() === c.description.toLowerCase() && !(x.system === SAGE_SYSTEM && x.ref === c.id));
    if (!holder) continue;
    const who = `category ${holder.name} (id ${holder.id}, ${holder.ref ? `${holder.system ?? 'no system'} ${holder.ref}` : 'no external reference'})`;
    refusedCategories.set(c.id, c.description);
    refusals.push({ entity: 'category', sageId: c.id, label: c.description, code: 'category_name_in_use', reasons: [`the name is held by ${who}, which this migration does not own: it is never renamed or adopted`] });
  }

  const items: PlannedItem[] = [];
  /** The items that will really be sent: the only ones a PO line may name. */
  const sentCodes: Record<string, string> = {};
  const usedCategories = new Set<string>();
  for (const item of byStableKey(parsed.items, (i) => i.id)) {
    if (item.category && refusedCategories.has(item.category.id)) {
      refusals.push({ entity: 'item', sageId: item.id, label: item.code, code: 'category_refused', reasons: [`its category ${item.category.description} is refused (category_name_in_use), so the item is not imported`] });
      continue;
    }
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
    const tooLong = po.lines.map((l, n) => ({ n, len: l.description.length + (l.itemId !== null && sentCodes[l.itemId] ? ` [item ${sentCodes[l.itemId]}]`.length : 0) }))
      .find((x) => x.len > MAX_LINE_DESCRIPTION);
    if (tooLong) { refuse('line_description_too_long', `line ${tooLong.n + 1}: the description with its item code is ${tooLong.len} characters, over the ${MAX_LINE_DESCRIPTION} a PO line takes (nothing is cut)`); continue; }
    const element = mapSagePurchaseOrder(po, supplier.id, sentCodes, opts.poGlAccountId);
    // Under the block policy the PO tool refuses the WHOLE batch for any approved PO with an account-less line (unless the budget check
    // is skipped): refused here, per row, so the dry run does not fail on it.
    if (existing.budgetPolicy === 'block' && !opts.skipBudgetCheck && !opts.poGlAccountId && element.status === 'open') {
      refuse('accountless_under_block_policy', 'the company\'s budget policy is block, and an approved (open) PO whose lines have no GL account is refused by the PO tool for the whole batch. Run with --skip-budget-check (owner or admin), or --po-gl-account <uuid> (every line posts to that one account), or import open POs as drafts (OPEN_SAGE_PO_IMPORTED_AS in sagePoStatus.ts)');
      continue;
    }
    const checked = parsePurchaseOrder(element, 0);
    if (typeof checked === 'string') { refuse('tool_refuses', checked); continue; }
    purchaseOrders.push({ sageId: po.id, documentNumber: po.documentNumber, totalCents: checked.totals.total, element, pdfFile: po.pdfFile });
  }
  return { categories, items, purchaseOrders, refusals };
}
