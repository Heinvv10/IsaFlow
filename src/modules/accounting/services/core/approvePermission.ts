/**
 * The per-module `approve` permission on every person's approval path (#1656): Settings ->
 * User Access and the admin portal set it (company_user_permissions), checkPermission decides it
 * from the database (owner/admin always; a manager unless unticked; a legacy accountant /
 * bookkeeper only when granted; a viewer never).
 *
 * Which module a document's approval belongs to is APPROVE_MODULE_BY_DOCUMENT, so the approval
 * routes, the services, the MCP tools and the approval-request decide path ask the same question.
 */

import { checkPermission } from '@/lib/auth/permissionService';

export type ApproveModule = 'suppliers' | 'customers';

/** The module whose Approve governs each approvable document type (R-035 document types). */
export const APPROVE_MODULE_BY_DOCUMENT: Readonly<Record<string, ApproveModule>> = Object.freeze({
  supplier_invoice: 'suppliers',
  supplier_credit_note: 'suppliers',
  supplier_payment: 'suppliers',
  payment_batch: 'suppliers',
  purchase_order: 'suppliers',
  customer_credit_note: 'customers',
});

const MODULE_LABEL: Record<ApproveModule, string> = { suppliers: 'Suppliers & AP', customers: 'Customers & AR' };

export function approveRefusedMessage(module: ApproveModule, what: string): string {
  return `You do not have permission to approve ${what}. An owner or admin can grant "Approve" on ${MODULE_LABEL[module]} in User Access.`;
}

/** Raised before any write when the person may not approve; routes answer it 403 (respondIfApprovePermissionRefused). */
export class ApprovePermissionError extends Error {
  readonly code = 'APPROVE_PERMISSION_REFUSED';
  constructor(readonly module: ApproveModule, what: string) {
    super(approveRefusedMessage(module, what));
    this.name = 'ApprovePermissionError';
  }
}

export function mayApprove(companyId: string, userId: string, module: ApproveModule): Promise<boolean> {
  return checkPermission(companyId, userId, module, 'approve');
}

export async function assertMayApprove(companyId: string, userId: string, module: ApproveModule, what: string): Promise<void> {
  if (!(await mayApprove(companyId, userId, module))) throw new ApprovePermissionError(module, what);
}
