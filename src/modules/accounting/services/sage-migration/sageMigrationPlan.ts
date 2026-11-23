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
import { storedPoFrom, type StoredPo } from './sagePoContent';
import type { ParsedExport, RowRefusal } from './sageExportTypes';
import { mapSageCategory, mapSageItem, SAGE_SYSTEM } from './sageItemMapping';
import { MAX_LINE_DESCRIPTION, mapSagePurchaseOrder, type ItemLink } from './sagePurchaseOrderMapping';
import type { SupplierResolution } from './sageSuppliers';
import { byStableKey } from './sageBatches';
import type { ExistingItem, Snapshot } from './sageSnapshot';
import { validateItemFields } from '@/modules/accounting/services/items/itemFieldValidation';
import { parsePurchaseOrder } from '@/lib/mcp/tools/purchaseOrderImportArgs';

export interface PlannedItem { sageId: string; row: Record<string, unknown> }
export interface PlannedPo {
  sageId: string; documentNumber: string; totalCents: number; element: Record<string, unknown>; pdfFile: string | null;
  /** What the PO tool would STORE for it (its own parse of `element`: the unit price of a line is net / quantity to 6 dp, not the Sage price). */
  stored: StoredPo;
  /** Set for a PO already booked whose Sage supplier does not resolve: sent under its booked supplier, listed as a difference. */
  supplierProblem?: string;
  /** What the plan sends for this PO's lines: how many are linked by item_code, which are not (and why). What the books end with is measured (sageLineLinks). */
  lineLinks: { linked: number; notLinked: NotLinkedLine[] };
}

export type NotLinkedReason = 'inactive' | 'refused';
/** A line that names an item but is sent WITHOUT item_code (the item is inactive or refused): it keeps the item's code as a suffix. */
export interface NotLinkedLine { poNumber: string; line: number; itemCode: string; reason: NotLinkedReason }

export interface MigrationPlan {
  categories: Array<Record<string, unknown>>;
  items: PlannedItem[];
  purchaseOrders: PlannedPo[];
  refusals: RowRefusal[];
  /** PO lines (of the POs that are sent) linked to their item by item_code, and those that are not, with why. */
  lineLinks: { linked: number; notLinked: NotLinkedLine[] };
}

export type Existing = Pick<Snapshot, 'items' | 'categories' | 'poNumbers' | 'budgetPolicy' | 'inactiveSuppliers'> & Partial<Pick<Snapshot, 'poContent' | 'duplicatePoRefs'>>;

/** The company's items indexed ONCE by (system sage) reference and by code: the plan looks items up per item and per PO line. First one wins. */
interface ItemIndex { byRef: ReadonlyMap<string, ExistingItem>; byCode: ReadonlyMap<string, readonly ExistingItem[]> }

function indexItems(items: readonly ExistingItem[]): ItemIndex {
  const byRef = new Map<string, ExistingItem>();
  // By the TRIMMED code: the item tool trims what it stores, the app's own edit does not, and the PO tool trims item_code; a code with
  // whitespace is the same code to a person and to the PO tool. Several items can share one trimmed code ('FIB-0001' and 'FIB-0001 ').
  const byCode = new Map<string, ExistingItem[]>();
  for (const i of items) {
    // A live row wins over a deleted one with the same reference (the snapshot has no order): the same rule itemBatchSalt, the ownership
    // check and linkFor apply.
    if (i.system === SAGE_SYSTEM && i.ref !== null && (!byRef.has(i.ref) || (byRef.get(i.ref)!.deleted && !i.deleted))) byRef.set(i.ref, i);
    const key = i.code.trim();
    byCode.set(key, [...(byCode.get(key) ?? []), i]);
  }
  return { byRef, byCode };
}

/**
 * Why `sageId`/`code` must not be sent, or null. bulk_upsert_items matches by Sage reference and then by CODE, and updates what it
 * matches: a Sage item whose code equals an item IsaFlow already holds would overwrite it (a tracked item with stock turned into
 * an untracked service, a live item deactivated). So the migration only ever updates an item it owns (system sage, this id):
 * a code held by any other item, with or without an external reference, deleted or not, is refused and the item named.
 */
function itemConflict(sageId: string, code: string, index: ItemIndex): { code: string; reason: string } | null {
  const byRef = index.byRef.get(sageId);
  const byCode = (index.byCode.get(code.trim()) ?? []).find((h) => h.id !== byRef?.id); // an item OTHER than the migration's own holding the code
  const held = (i: ExistingItem) => `item ${i.code} (id ${i.id}, ${i.ref ? `${i.system ?? 'no system'} ${i.ref}` : 'no external reference'}${i.deleted ? ', deleted' : ''})`;
  if (byRef && byCode) {
    return { code: 'ref_code_conflict', reason: `Sage id ${sageId} is already ${held(byRef)} and code ${code} belongs to a different item, ${held(byCode)}` };
  }
  if (byCode) {
    // Another Sage item (a different Sage id) is the migration's own, only under another id; anything else is not the migration's.
    const why = byCode.system === SAGE_SYSTEM && byCode.ref !== null
      ? `under a different Sage id (this row is Sage id ${sageId}): the migration does not overwrite one Sage item with another`
      : 'which this migration does not own: an item it did not import is never updated';
    return { code: 'code_held_by_existing_item', reason: `code ${code} is held by ${held(byCode)}, ${why}` };
  }
  if (byRef?.deleted) return { code: 'item_deleted', reason: `the matching ${held(byRef)} has been deleted` };
  return null;
}

/** Whether a PO line naming Sage item `id` is linked by item_code, and the code to name it by. */
function linkFor(
  id: string, sent: ReadonlyMap<string, { code: string; active: boolean }>, index: ItemIndex, displayCodes: Readonly<Record<string, string>>,
): ItemLink & ({ link: true } | { link: false; reason: NotLinkedReason }) {
  const s = sent.get(id);
  if (s) return s.active ? { code: s.code, link: true } : { code: s.code, link: false, reason: 'inactive' };
  // Not sent this run: only an item already in the books, owned by the migration, can be linked, BY ITS ID (a stored code can carry
  // whitespace the PO tool trims, and the trimmed code can belong to another item or to none).
  const owned = index.byRef.get(id);
  if (owned && !owned.deleted) return owned.isActive ? { code: owned.code, id: owned.id, link: true } : { code: owned.code, link: false, reason: 'inactive' };
  return { code: displayCodes[id]!, link: false, reason: 'refused' };
}

export function planMigration(parsed: ParsedExport, suppliers: ReadonlyMap<string, SupplierResolution>, existing: Existing, opts: { poGlAccountId?: string; skipBudgetCheck?: boolean } = {}): MigrationPlan {
  const refusals: RowRefusal[] = [...parsed.refusals];
  const index = indexItems(existing.items);

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
  /** The items that will really be sent (id -> code, active): a PO line is linked to one of these only when it is active. */
  const sent = new Map<string, { code: string; active: boolean }>();
  const usedCategories = new Set<string>();
  for (const item of byStableKey(parsed.items, (i) => i.id)) {
    if (item.category && refusedCategories.has(item.category.id)) {
      refusals.push({ entity: 'item', sageId: item.id, label: item.code, code: 'category_refused', reasons: [`its category ${item.category.description} is refused (category_name_in_use), so the item is not imported`] });
      continue;
    }
    const conflict = itemConflict(item.id, item.code, index);
    if (conflict) { refusals.push({ entity: 'item', sageId: item.id, label: item.code, code: conflict.code, reasons: [conflict.reason] }); continue; }
    // An owned item with stock movements keeps its type and tracking: the migration always sends untracked, and a Sage service is a service.
    const found = index.byRef.get(item.id);
    const owned = found && !found.deleted ? found : undefined;
    if (owned?.hasMovements && (owned.itemType !== (item.physical ? 'physical' : 'service') || owned.inventoryTracked)) {
      refusals.push({
        entity: 'item', sageId: item.id, label: item.code, code: 'item_has_stock_movements',
        reasons: [`item ${owned.code} (id ${owned.id}) has stock movements and is ${owned.itemType}, ${owned.inventoryTracked ? 'tracked' : 'untracked'}; the export would make it ${item.physical ? 'physical' : 'service'} and untracked, which a book with stock cannot take`],
      });
      continue;
    }
    const row = mapSageItem(item);
    const checked = validateItemFields(row);
    if (!checked.ok) {
      refusals.push({ entity: 'item', sageId: item.id, label: item.code, code: 'tool_refuses', reasons: [`${checked.code}: ${checked.reason}`] });
      continue;
    }
    items.push({ sageId: item.id, row });
    sent.set(item.id, { code: item.code, active: item.active });
    if (item.category) usedCategories.add(item.category.id);
  }
  // Only categories an item that is being sent uses.
  const categories = byStableKey(parsed.categories.filter((c) => usedCategories.has(c.id)), (c) => c.id).map(mapSageCategory);

  const purchaseOrders: PlannedPo[] = [];
  const lineLinks: MigrationPlan['lineLinks'] = { linked: 0, notLinked: [] };
  for (const po of byStableKey(parsed.purchaseOrders, (p) => p.id)) {
    const supplier = suppliers.get(po.supplierId);
    const refuse = (code: string, reason: string) => refusals.push({ entity: 'purchase_order', sageId: po.id, label: po.documentNumber, code, reasons: [reason] });
    // More than one IsaFlow PO carries this Sage reference (nothing makes it unique): the tool and the books' reads would each pick one.
    const heldBy = existing.duplicatePoRefs?.get(po.id);
    if (heldBy) { refuse('po_ref_ambiguous', `Sage purchase order ${po.id} is the external reference of ${heldBy.length} IsaFlow purchase orders (${heldBy.join(', ')}): none is picked; remove the reference from all but one`); continue; }
    const holder = existing.poNumbers.get(po.documentNumber);
    // A PO this migration already booked is sent again on a re-run (the tool replays it): a supplier deactivated or a budget policy
    // turned to block since then must not drop it from what is sent (--expect-pos would miss, and it would escape the differences).
    // BY REFERENCE: the tool replays a PO by its Sage reference, whatever number it carries now (a renumbered PO is listed as a difference).
    const alreadyBooked = (existing.poContent?.has(po.id) ?? false) || (holder !== undefined && holder.system === SAGE_SYSTEM && holder.ref === po.id);
    const unresolved = !supplier ? { code: 'supplier_unresolved', reason: `supplier ${po.supplierId} was not looked up` } : 'id' in supplier ? null : supplier;
    let supplierId: string;
    let supplierProblem: string | undefined;
    if (unresolved) {
      // A booked PO whose Sage supplier no longer resolves (renamed, merged, deactivated, deleted in IsaFlow) is still sent: the tool replays
      // it. It goes under the supplier it is booked to (the tool does not compare it), and the problem is LISTED as a difference, so a
      // real supplier move is not hidden by adopting the booked one as if it were the resolution.
      const content = alreadyBooked ? existing.poContent?.get(po.id) : undefined;
      if (!content) { refuse(unresolved.code, unresolved.reason); continue; }
      if (content.supplierDeleted) {
        // The tool answers Not found for the WHOLE batch of a PO naming a deleted supplier, a replay included: it cannot be sent.
        refuse('booked_supplier_deleted', `${unresolved.reason}; the PO is booked to ${content.supplierName ?? 'a supplier'} (${content.header.supplier_id}), which is deleted in IsaFlow: the PO tool cannot replay it. Restore that supplier (or give it Sage reference ${po.supplierId}), then run again`);
        continue;
      }
      supplierId = String(content.header.supplier_id);
      supplierProblem = `Sage supplier ${po.supplierId}${po.supplierName ? ` "${po.supplierName}"` : ''} not found in IsaFlow (${unresolved.reason}); PO is booked to ${content.supplierName ?? 'a supplier'} (${content.header.supplier_id})`;
    } else {
      supplierId = (supplier as { id: string }).id;
    }
    if (!alreadyBooked && existing.inactiveSuppliers.has(supplierId)) { refuse('supplier_inactive', `supplier ${supplierId} is inactive in IsaFlow: activate it, or the PO is not imported`); continue; }
    if (holder && !alreadyBooked) {
      refuse('po_number_taken', `${po.documentNumber} already belongs to a purchase order (${holder.ref ? `${holder.system} ${holder.ref}` : 'no external reference'}); the tool would refuse the whole batch`);
      continue;
    }
    // The plan's decision for each item a line names: linked by item_code (the item is sent and active, or present, owned and active),
    // or not linked (inactive; refused) and then it keeps " [item CODE]". The PO tool refuses a WHOLE batch for an inactive or unknown
    // item, so a line the plan is not sure of must go without item_code. An item with no readable code at all cannot be named.
    const links: Record<string, ItemLink> = {};
    const notLinked: NotLinkedLine[] = [];
    let linked = 0;
    for (const [n, l] of po.lines.entries()) {
      if (l.itemId === null) continue;
      const decision = linkFor(l.itemId, sent, index, parsed.itemCodes);
      links[l.itemId] = { code: decision.code, link: decision.link, ...(decision.link && decision.id ? { id: decision.id } : {}) };
      if (decision.link) linked++;
      else notLinked.push({ poNumber: po.documentNumber, line: n + 1, itemCode: decision.code, reason: decision.reason });
    }
    const tooLong = po.lines.map((l, n) => ({ n, len: l.description.length + (l.itemId !== null && !links[l.itemId]?.link ? ` [item ${links[l.itemId!]!.code}]`.length : 0) }))
      .find((x) => x.len > MAX_LINE_DESCRIPTION);
    if (tooLong) { refuse('line_description_too_long', `line ${tooLong.n + 1}: the description with its item code is ${tooLong.len} characters, over the ${MAX_LINE_DESCRIPTION} a PO line takes (nothing is cut)`); continue; }
    const element = mapSagePurchaseOrder(po, supplierId, links, opts.poGlAccountId);
    // Under the block policy the PO tool refuses the WHOLE batch for any approved PO with an account-less line (unless the budget check
    // is skipped): refused here, per row, so the dry run does not fail on it.
    if (!alreadyBooked && existing.budgetPolicy === 'block' && !opts.skipBudgetCheck && !opts.poGlAccountId && element.status === 'open') {
      refuse('accountless_under_block_policy', 'the company\'s budget policy is block, and an approved (open) PO whose lines have no GL account is refused by the PO tool for the whole batch. Run with --skip-budget-check (owner or admin), or --po-gl-account <uuid> (every line posts to that one account), or import open POs as drafts (OPEN_SAGE_PO_IMPORTED_AS in sagePoStatus.ts)');
      continue;
    }
    const checked = parsePurchaseOrder(element, 0);
    if (typeof checked === 'string') { refuse('tool_refuses', checked); continue; }
    purchaseOrders.push({ sageId: po.id, documentNumber: po.documentNumber, totalCents: checked.totals.total, element, pdfFile: po.pdfFile, lineLinks: { linked, notLinked },
      ...(supplierProblem ? { supplierProblem } : {}),
      stored: storedPoFrom(checked, (n) => {
        const itemId = po.lines[n]!.itemId;
        const link = itemId === null ? undefined : links[itemId];
        if (!link) return { itemId: null, itemCode: null };
        // Linked by id, or by the code of an item this run sends (its id is in the books on a re-run; "item:CODE" when it is not there yet).
        const id = !link.link ? null : link.id ?? index.byCode.get(link.code.trim())?.find((x) => !x.deleted)?.id ?? `item:${link.code}`;
        return { itemId: id, itemCode: link.code };
      }) });
    lineLinks.linked += linked;
    lineLinks.notLinked.push(...notLinked);
  }
  return { categories, items, purchaseOrders, refusals, lineLinks };
}
