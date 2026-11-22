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
 *   Lines[].Description                    description, plus " [item <Code>]" when the line names an item
 *   Lines[].Quantity / UnitPriceExclusive  quantity / unit_price
 *   Lines[].TaxPercentage or TaxTypeId     tax_rate
 *   Lines[].Exclusive / Tax                line_total / tax_amount (the source's own figures)
 *   (option --po-gl-account)               gl_account_id on every line: the expense account the budget check judges them on; with none a
 *                                          line is "No budget" and is never blocked
 *
 * The PO tool has no item_id on a line (its line keys refuse one), so the item link is the code in the description.
 */
import type { SagePoLine, SagePurchaseOrder } from './sageExportTypes';
import { importStatusFor } from './sagePoStatus';
import { SAGE_SYSTEM } from './sageItemMapping';

const MAX_DESCRIPTION = 500;

function lineDescription(line: SagePoLine, itemCodes: Readonly<Record<string, string>>): string {
  const code = line.itemId === null ? null : itemCodes[line.itemId];
  if (!code) return line.description;
  const suffix = ` [item ${code}]`;
  return `${line.description.slice(0, MAX_DESCRIPTION - suffix.length)}${suffix}`;
}

export function mapSagePurchaseOrder(
  po: SagePurchaseOrder, supplierId: string, itemCodes: Readonly<Record<string, string>>, glAccountId?: string,
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
    lines: po.lines.map((l) => ({
      description: lineDescription(l, itemCodes),
      quantity: l.quantity,
      unit_price: l.unitPriceExclusive,
      tax_rate: l.taxRate,
      ...(glAccountId ? { gl_account_id: glAccountId } : {}),
      ...(l.exclusive !== null ? { line_total: l.exclusive, ...(l.tax !== null ? { tax_amount: l.tax } : {}) } : {}),
    })),
  };
}
