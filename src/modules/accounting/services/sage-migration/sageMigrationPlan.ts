/**
 * The parsed export + the supplier resolutions -> what is sent, and what is refused before sending. PURE.
 *
 * A row the tools' own pure validators would refuse (validateItemFields for an item, parsePurchaseOrder for a PO: field rules,
 * line amounts, the expected totals to the cent) is refused HERE with the tool's reason, so one bad row costs that row and not
 * the 500 or 100 around it (the tools refuse a whole batch for one bad row). What only the database can decide (a code held by
 * another item, a PO number already taken, a budget block) still fails its batch, and the report says so.
 */
import type { ParsedExport, RowRefusal } from './sageExportTypes';
import { mapSageCategory, mapSageItem } from './sageItemMapping';
import { mapSagePurchaseOrder } from './sagePurchaseOrderMapping';
import type { SupplierResolution } from './sageSuppliers';
import { byStableKey } from './sageBatches';
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

export function planMigration(parsed: ParsedExport, suppliers: ReadonlyMap<string, SupplierResolution>): MigrationPlan {
  const refusals: RowRefusal[] = [...parsed.refusals];

  const items: PlannedItem[] = [];
  const usedCategories = new Set<string>();
  for (const item of byStableKey(parsed.items, (i) => i.id)) {
    const row = mapSageItem(item);
    const checked = validateItemFields(row);
    if (!checked.ok) {
      refusals.push({ entity: 'item', sageId: item.id, label: item.code, code: 'tool_refuses', reasons: [`${checked.code}: ${checked.reason}`] });
      continue;
    }
    items.push({ sageId: item.id, row });
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
    const element = mapSagePurchaseOrder(po, supplier.id, parsed.itemCodes);
    const checked = parsePurchaseOrder(element, 0);
    if (typeof checked === 'string') { refuse('tool_refuses', checked); continue; }
    purchaseOrders.push({ sageId: po.id, documentNumber: po.documentNumber, totalCents: checked.totals.total, element, pdfFile: po.pdfFile });
  }
  return { categories, items, purchaseOrders, refusals };
}
