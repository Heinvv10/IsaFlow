/**
 * Who may approve a supplier invoice (#1656): the Suppliers & AP module's `approve` permission,
 * as Settings -> User Access and the admin portal set it. Owner and admin always may; a manager
 * may unless an owner or admin has unticked Approve on that module for them (the manager default
 * includes approve); a viewer never reaches here (withWriteAccess refuses the POST first).
 *
 * Checked by every person's approve path before any read or write of the bill: the single and
 * bulk routes, and the MCP approve and bulk-approve tools. The recurring-bill runner approves as
 * the system and does not ask.
 */

import { checkPermission } from '@/lib/auth/permissionService';

export const SUPPLIER_INVOICE_PERMISSION_MODULE = 'suppliers';

export const SUPPLIER_INVOICE_APPROVE_REFUSED =
  'You do not have permission to approve supplier invoices. An owner or admin can grant "Approve" on Suppliers & AP in User Access.';

export function mayApproveSupplierInvoices(
  companyId: string, userId: string, companyRole: string | null | undefined,
): Promise<boolean> {
  return checkPermission(companyId, userId, companyRole ?? '', SUPPLIER_INVOICE_PERMISSION_MODULE, 'approve');
}
