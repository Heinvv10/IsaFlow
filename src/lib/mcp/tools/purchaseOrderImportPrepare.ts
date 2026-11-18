/**
 * bulk_create_purchase_orders: every id the batch names, proved to be this company's, before the first write.
 * Reads only. A foreign or missing supplier / item is "Not found" (the same reply either way: no existence oracle);
 * a line account another company owns, or an inactive one, is the bill lines' refusal (`documentLineAccountGuard`);
 * CC1 / CC2 / BU go through the bills' resolver and derivation (`dimensionArgs`): a code, alias or UUID, CC1 derived
 * from CC2, a contradicting CC1 refused, and a cost-of-sales line with no project warned (or refused where the company
 * blocks it). Supplier default dimensions are not applied: they are a bill rule (`ap/purchaseOrderLineDimensions`).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { documentLineAccountRefusal } from '@/modules/accounting/services/gl/documentLineAccountGuard';
import type { ImportPo } from '@/modules/accounting/services/ap/purchaseOrderImport';
import { dimensionWarningsOrRefusal, resolveLineDimensionRefs } from './dimensionArgs';
import type { ParsedPo } from './purchaseOrderImportArgs';
import { NOT_FOUND } from './toolHelpers';

export interface Prepared { items: ImportPo[]; warnings: string[] }

export async function preparePurchaseOrders(companyId: string, batch: readonly ParsedPo[]): Promise<Prepared | string> {
  for (const supplierId of new Set(batch.map((p) => p.supplierId))) {
    if (!(await supplierBelongsToCompany(companyId, supplierId))) return NOT_FOUND;
  }

  const accountIds = batch.flatMap((p) => p.lines.map((l) => l.glAccountId));
  if (await documentLineAccountRefusal(companyId, accountIds)) {
    for (const p of batch) {
      const own = await documentLineAccountRefusal(companyId, p.lines.map((l) => l.glAccountId));
      if (own) return `purchase_orders[${p.index}]: ${own}`;
    }
  }

  const productIds = [...new Set(batch.flatMap((p) => p.lines.map((l) => l.productId)).filter((v): v is string => !!v))];
  if (productIds.length > 0) {
    const found = (await sql`
      SELECT id FROM products WHERE company_id = ${companyId}::UUID AND id = ANY(${productIds}::UUID[])
    `) as DbRow[];
    if (found.length !== productIds.length) return `${NOT_FOUND}: an item_id is not an item of this company`;
  }

  const items: ImportPo[] = [];
  const warnings: string[] = [];
  for (const p of batch) {
    const label = (i: number) => `purchase_orders[${p.index}].lines[${i}]`;
    const dims = await resolveLineDimensionRefs(companyId, p.lines.map((l) => l.dims), label);
    if (typeof dims === 'string') return dims;
    const lines = p.lines.map((l, i) => ({
      description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate,
      netCents: l.cents.net, taxCents: l.cents.tax, glAccountId: l.glAccountId, productId: l.productId,
      cc1Id: dims[i]?.cc1Id ?? null, cc2Id: dims[i]?.cc2Id ?? null, buId: dims[i]?.buId ?? null,
    }));
    const cos = await dimensionWarningsOrRefusal(companyId, lines, label);
    if (typeof cos === 'string') return cos;
    warnings.push(...cos.warnings);
    items.push({
      index: p.index, poNumber: p.poNumber, supplierId: p.supplierId, orderDate: p.orderDate, deliveryDate: p.deliveryDate,
      reference: p.reference, notes: p.notes, status: p.status, ref: p.ref, totals: p.totals, lines,
    });
  }
  return { items, warnings };
}
