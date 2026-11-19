/**
 * Who may approve a supplier invoice (#1656): the Suppliers & AP module's `approve` permission
 * (core/approvePermission.ts). Owner and admin always may; a manager may unless an owner or admin
 * has unticked Approve on that module for them; a former accountant / bookkeeper only when
 * granted; a viewer never reaches here (withWriteAccess refuses the POST first).
 *
 * Checked by every person's approve path before any read or write of the bill: the single and
 * bulk routes, the MCP approve and bulk-approve tools, a person's run of an autoPost recurring
 * template (the bill is left a draft) and a capture post (the bill is stored a draft for review).
 */

import { approveRefusedMessage, mayApprove } from '@/modules/accounting/services/core/approvePermission';

export const SUPPLIER_INVOICE_APPROVE_REFUSED = approveRefusedMessage('suppliers', 'supplier invoices');

export function mayApproveSupplierInvoices(companyId: string, userId: string): Promise<boolean> {
  return mayApprove(companyId, userId, 'suppliers');
}
