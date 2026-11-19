/**
 * update_purchase_order: everything decided before the first write, reads only (design docs/design/mcp-po-maintenance.md,
 * decision 1). The supplier and the PO are this company's ("Not found" either way: no existence oracle); item codes become item
 * ids; line CC1 / CC2 / BU refs resolve as on the bulk import; then the PUT's own checks run (`validatePoEdit`: supplier change on a
 * linked PO, item defaults, accounts, dimensions); only then are the lines priced (a rate the item supplied counts) and the totals
 * compared with `expected_totals`.
 */
import { SupplierNotInCompanyError, supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { DocumentLineAccountRefusal } from '@/modules/accounting/services/gl/documentLineAccountGuard';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { ItemLineRefusal } from '@/modules/accounting/services/items/itemLineDefaults';
import { itemIdsByCode } from '@/modules/accounting/services/items/itemCodeLookup';
import { PurchaseOrderEditRefusal, validatePoEdit, type PoEditLine } from '@/modules/accounting/services/ap/purchaseOrderEditChecks';
import {
  cents, expectedTotalsRefusal, lineCents, poCents, storedUnitPrice,
} from '@/modules/accounting/services/ap/purchaseOrderImportAmounts';
import type { PoLineRow } from '@/modules/accounting/services/ap/purchaseOrderLinesWrite';
import type { PoUpdateRequest } from '@/modules/accounting/services/ap/purchaseOrderUpdate';
import { dimensionWarningsOrRefusal, resolveLineDimensionRefs } from './dimensionArgs';
import { resolvePoId } from './purchaseOrderMaintenanceArgs';
import type { ParsedUpdate } from './purchaseOrderUpdateArgs';
import { MAX_MONEY, NOT_FOUND } from './toolHelpers';

const MAX_CENTS = cents(MAX_MONEY);

export interface PreparedUpdate { request: PoUpdateRequest; warnings: string[] }

export async function prepareUpdate(companyId: string, parsed: ParsedUpdate): Promise<PreparedUpdate | string> {
  const poId = await resolvePoId(companyId, parsed);
  if (!poId) return NOT_FOUND;
  const { header, lines } = parsed;
  if (header.supplierId && !(await supplierBelongsToCompany(companyId, header.supplierId))) return NOT_FOUND;
  if (!lines) return { request: { poId, header, replace: null }, warnings: [] };

  const label = (i: number) => `lines[${i}]`;
  const byCode = await itemIdsByCode(companyId, lines.flatMap((l) => (l.itemCode ? [l.itemCode] : [])));
  for (const [i, l] of lines.entries()) {
    if (l.itemCode && !byCode.has(l.itemCode)) return `${label(i)}.item_code: no item with the code "${l.itemCode}" in this company`;
  }
  const dims = await resolveLineDimensionRefs(companyId, lines.map((l) => l.dims), label);
  if (typeof dims === 'string') return dims;

  const sent: PoEditLine[] = lines.map((l, i) => ({
    description: l.description, quantity: l.quantity, unit_price: l.unitPrice, tax_rate: l.taxRate ?? null, gl_account_id: l.glAccountId,
    item_id: l.itemCode ? byCode.get(l.itemCode)! : l.itemId,
    // A replacement line has exactly the dimensions it names (null clears): nothing is kept from the old lines.
    cc1_id: dims[i]?.cc1Id ?? null, cc2_id: dims[i]?.cc2Id ?? null, bu_id: dims[i]?.buId ?? null,
  }));
  let checked;
  try {
    checked = await validatePoEdit(companyId, poId, header.supplierId, sent);
  } catch (err) {
    if (err instanceof SupplierNotInCompanyError) return NOT_FOUND;
    if (err instanceof PurchaseOrderEditRefusal || err instanceof DocumentLineAccountRefusal || isDimensionRefusal(err)) return err.message;
    if (err instanceof ItemLineRefusal) return err.message.replace(/^items\[(\d+)\]/, 'lines[$1]');
    throw err;
  }
  const items = checked.items!;

  const rows: PoLineRow[] = [];
  for (const [i, l] of lines.entries()) {
    const resolved = items[i]!;
    const rate = resolved.tax_rate ?? 15;
    const money = lineCents({ quantity: l.quantity, unitPrice: l.unitPrice, taxRate: rate, lineTotal: l.lineTotal, taxAmount: l.taxAmount }, parsed.inclusive);
    if (typeof money === 'string') return `${label(i)}: ${money}`;
    if (money.net + money.tax > MAX_CENTS) return `${label(i)}: the line amount is more than the largest amount a document holds`;
    rows.push({
      description: l.description, quantity: l.quantity, unitPrice: storedUnitPrice(l.quantity, money.net), taxRate: rate, netCents: money.net, taxCents: money.tax,
      glAccountId: resolved.gl_account_id ?? null, cc1Id: dims[i]?.cc1Id ?? null, cc2Id: dims[i]?.cc2Id ?? null, buId: dims[i]?.buId ?? null,
      itemId: resolved.item_id ?? null,
    });
  }
  const totals = poCents(rows.map((r) => ({ net: r.netCents, tax: r.taxCents })));
  if (totals.total > MAX_CENTS) return 'the PO total is more than the largest amount a document holds';
  const mismatch = expectedTotalsRefusal(totals, parsed.expected);
  if (mismatch) return mismatch;

  const cos = await dimensionWarningsOrRefusal(companyId, rows, label);
  if (typeof cos === 'string') return cos;
  return { request: { poId, header, replace: { lines: rows, totals } }, warnings: cos.warnings };
}
