/**
 * The per-module `approve` permission on every person's approval path (#1656): Settings ->
 * User Access and the admin portal set it (company_user_permissions), checkPermission decides it
 * from the database (owner/admin always; a manager unless unticked; a legacy accountant /
 * bookkeeper only when granted; a viewer never).
 *
 * Which module a document's approval belongs to is APPROVE_MODULE_BY_DOCUMENT, so the approval
 * routes, the MCP tools and the approval-request decide path ask the same question. Asked at each
 * person's entry point (route, tool), not inside the posting services, which also serve fixtures
 * and system callers.
 */

import { sql } from '@/lib/neon';
import { checkPermission } from '@/lib/auth/permissionService';
import { logAuditOrThrow } from './auditTrailService';

export type ApproveModule = 'suppliers' | 'customers' | 'accounts' | 'payroll';

/** The module whose Approve governs each approvable document type (R-035 document types and purchase orders). */
export const APPROVE_MODULE_BY_DOCUMENT: Readonly<Record<string, ApproveModule>> = Object.freeze({
  supplier_invoice: 'suppliers',
  supplier_credit_note: 'suppliers',
  supplier_payment: 'suppliers',
  payment_batch: 'suppliers',
  purchase_order: 'suppliers',
  customer_invoice: 'customers',
  customer_credit_note: 'customers',
  manual_journal: 'accounts',
  pay_run: 'payroll',
});

/**
 * Approval-request types decided with no module Approve, each with its reason. Every other type is
 * either in APPROVE_MODULE_BY_DOCUMENT, resolved from its document (`credit_note`), or refused:
 * an unknown type fails closed (review of #1670).
 */
export const UNGATED_APPROVAL_TYPES: Readonly<Record<string, string>> = Object.freeze({
  payment: 'legacy type: governs no supplier payment or batch since R-035 PR5 (approvalDocumentTypes LEGACY_TYPES); deciding it posts nothing',
  journal_entry: 'legacy type: governs no journal since R-035 PR6 (manual journals are manual_journal); deciding it posts nothing',
});

const MODULE_LABEL: Record<ApproveModule, string> = {
  suppliers: 'Suppliers & AP', customers: 'Customers & AR', accounts: 'Chart of Accounts & GL', payroll: 'Payroll',
};

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

/**
 * A credit note's approval: its type decides the module (customer: Customers & AR, supplier:
 * Suppliers & AP). A note this company does not have is left to the approve path's own answer.
 */
export async function assertMayApproveCreditNote(companyId: string, userId: string, creditNoteId: string): Promise<void> {
  const rows = await sql`
    SELECT type FROM credit_notes WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID
  ` as Array<{ type: string }>;
  const type = rows[0]?.type;
  if (type !== 'customer' && type !== 'supplier') return;
  await assertMayApprove(companyId, userId, type === 'customer' ? 'customers' : 'suppliers', `${type} credit notes`);
}

/**
 * The Approve an approval request's decision takes: the document type's module, a legacy
 * `credit_note` resolved by the note's own type, 'ungated' for UNGATED_APPROVAL_TYPES, and null
 * (refuse) for any other type. A legacy credit note this company no longer has is 'missing': there
 * is nothing to approve, and the decide path answers it 404 before any write (R-035 contract L2).
 */
export async function approveModuleForRequest(
  companyId: string, documentType: string, documentId: string,
): Promise<ApproveModule | 'ungated' | 'missing' | null> {
  if (Object.hasOwn(APPROVE_MODULE_BY_DOCUMENT, documentType)) return APPROVE_MODULE_BY_DOCUMENT[documentType]!;
  if (Object.hasOwn(UNGATED_APPROVAL_TYPES, documentType)) return 'ungated';
  if (documentType !== 'credit_note') return null;
  const rows = await sql`
    SELECT type FROM credit_notes WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  ` as Array<{ type: string }>;
  const type = rows[0]?.type;
  if (type === undefined) return 'missing';
  return type === 'customer' ? 'customers' : type === 'supplier' ? 'suppliers' : null;
}

/**
 * A document a person's action would have approved, left a draft because they lack the module's
 * Approve (capture post, a recurring run): one audit row, in the request's transaction.
 */
export async function recordApproveWithheld(p: {
  companyId: string; userId: string; module: ApproveModule; entityType: string; entityId: string;
  entityRef: string | null; path: string;
}): Promise<void> {
  await logAuditOrThrow({
    companyId: p.companyId, userId: p.userId, action: 'reject', entityType: p.entityType, entityId: p.entityId,
    ...(p.entityRef ? { entityRef: p.entityRef.slice(0, 100) } : {}),
    changes: { fields: [], metadata: { approval: 'withheld', reason: 'no_approve_permission', module: p.module, path: p.path } },
  });
}
