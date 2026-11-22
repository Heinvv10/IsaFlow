/**
 * Sage purchase order -> one element of bulk_create_purchase_orders `purchase_orders`. PURE.
 *
 *   Sage                                   PO field
 *   DocumentNumber                         po_number (honoured exactly) and external_document_number
 *   ID                                     external_ref (external_system "sage"): the idempotency key of the row
 *   Date / DeliveryDate                    order_date / delivery_date
 *   Status                                 status (sagePoStatus: Pending, Overdue -> open; Invoiced -> billed; Cancelled -> cancelled)
 *   Reference                              reference
 *   "Sage status: <Status>" + Comments     notes (the Sage status is not otherwise kept: Overdue and Pending are both open)
 *   Exclusive / Tax / Total                expected_totals subtotal / tax_amount / total (checked to the cent by the tool)
 *   SupplierId / SupplierName              supplier_id (resolved by the runner: external ref, else exact name)
 *   Lines[].Description                    description; when the line names an item that is imported and active (or present, owned and
 *                                          active): item_code, no suffix. When the item is inactive or refused: " [item <Code>]" appended
 *                                          and no item_code (the PO tool refuses a whole batch for an inactive or unknown item)
 *   Lines[].Quantity / UnitPriceExclusive  quantity / unit_price
 *   Lines[].TaxPercentage or TaxTypeId     tax_rate
 *   Lines[].Exclusive / Tax                line_total / tax_amount (the source's own figures)
 *   (option --po-gl-account)               gl_account_id on every line: the expense account the budget check judges them on; with none a
 *                                          line is "No budget" (not judged; under the block policy the plan refuses an approved PO with none)
 *
 */
import type { SagePoLine, SagePurchaseOrder } from './sageExportTypes';
import { importStatusFor } from './sagePoStatus';
import { SAGE_SYSTEM } from './sageItemMapping';

/** The PO tool's description limit. */
export const MAX_LINE_DESCRIPTION = 500;

/** What the plan decided for the item a line names: its code, and whether the line is LINKED (item_code) or only carries it as text. */
export interface ItemLink { code: string; link: boolean }

/** The text of an UNLINKED line that names an item: its description and " [item CODE]". Never cut: over the limit is an error (the plan refuses first). */
export function suffixedDescription(description: string, code: string): string {
  const text = `${description} [item ${code}]`;
  if (text.length > MAX_LINE_DESCRIPTION) throw new Error(`a line description of ${text.length} characters passes the ${MAX_LINE_DESCRIPTION} the PO tool takes`);
  return text;
}

export function mapSagePurchaseOrder(
  po: SagePurchaseOrder, supplierId: string, itemLinks: Readonly<Record<string, ItemLink>>, glAccountId?: string,
): Record<string, unknown> {
  const status = importStatusFor(po.status);
  if (!status) throw new Error(`purchase order ${po.documentNumber}: status ${po.status} has no mapping`);
  const notes = [`Sage status: ${po.status}`, po.comments].filter((x): x is string => Boolean(x)).join('\n');
  return {
    po_number: po.documentNumber,
    supplier_id: supplierId,
    order_date: po.date,
    ...(po.deliveryDate ? { delivery_date: po.deliveryDate } : {}),
    ...(po.reference ? { reference: po.reference } : {}),
    notes,
    status,
    external_system: SAGE_SYSTEM,
    external_ref: po.id,
    external_document_number: po.documentNumber,
    expected_totals: { subtotal: po.exclusive, tax_amount: po.tax, total: po.total },
    lines: po.lines.map((l) => {
      const item = l.itemId === null ? undefined : itemLinks[l.itemId];
      return {
        description: item && !item.link ? suffixedDescription(l.description, item.code) : l.description,
        ...(item?.link ? { item_code: item.code } : {}),
        quantity: l.quantity,
        unit_price: l.unitPriceExclusive,
        tax_rate: l.taxRate,
        ...(glAccountId ? { gl_account_id: glAccountId } : {}),
        ...(l.exclusive !== null ? { line_total: l.exclusive, ...(l.tax !== null ? { tax_amount: l.tax } : {}) } : {}),
      };
    }),
  };
}
