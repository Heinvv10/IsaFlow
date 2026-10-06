/**
 * The declared import exemption from the supplier-invoice and customer-invoice
 * approval backstops (R-035, decision Q1; the triggers of migrations 712 and
 * 865 read it).
 *
 * The Sage staging imports, the Sage migration commit and the AP / AR
 * take-ons book bills and invoices that were approved or issued in the system
 * they come from, straight into the AP or AR population. They — and only
 * they — wrap that write in withApprovalGateExempt,
 * which sets the transaction-local `isaflow.approval_gate_exempt` to 'import'
 * for the write and clears it after. A census test pins the callers
 * (tests/unit/services/gl/approvalGateExemptCensus.test.ts): the GUC is a
 * setting any statement could set, so the control is who is allowed to.
 *
 * Exempt only for a high enough rank (Hein, review HIGH-2): with enforcement
 * on for supplier invoices, an OPEN bill (one entering the AP population
 * owing money) is honoured only when the importing user's company role ranks
 * at least as high as the strictest active supplier-invoice rule — otherwise
 * an import is how a lower rank books a payable no approver saw. A fully paid
 * historic bill owes nothing and imports for anyone. Customer invoices (PR4)
 * the same, against the strictest active customer-invoice rule: the importer
 * names the type (`documentType`, default 'supplier_invoice', so every bill
 * importer is checked exactly as before). The check runs here, in
 * the one wrapper, so no caller reaches the GUC around it; the importers also
 * call assertMayImportOpenBills up front, to refuse before their first write.
 *
 * In a savepoint so that a throw reverts the setting with the write
 * (ROLLBACK TO undoes a set_config made after the savepoint) instead of
 * leaving the rest of the transaction exempt.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { actorRank, requiredRank } from './approvalAuthority';
import { isEnforced, strictestActiveRuleRole } from './approvalEnforcement';

/** The document types an importer may bring in past their backstop. */
export type ImportedDocumentType = 'supplier_invoice' | 'customer_invoice';

const IMPORTED: Record<ImportedDocumentType, { approvals: string; documents: string }> = {
  supplier_invoice: { approvals: 'Supplier-invoice', documents: 'bills' },
  customer_invoice: { approvals: 'Customer-invoice', documents: 'invoices' },
};

/** An import of open bills or invoices past enforcement, by a role below the strictest rule. Routes answer 403. */
export class ApprovalImportAuthorityError extends Error {
  readonly code = 'IMPORT_APPROVAL_AUTHORITY_REQUIRED';
  constructor(actorRole: string | null, ruleRole: string, documentType: ImportedDocumentType = 'supplier_invoice') {
    const { approvals, documents } = IMPORTED[documentType];
    super(`${approvals} approvals are enforced, so importing open (unpaid) ${documents} needs the ${ruleRole} role or above `
      + `— the strictest active approval rule — and you hold ${actorRole ?? 'no role in this company'}. `
      + `Ask a ${ruleRole} to run the import, or import only fully paid ${documents}.`);
    this.name = 'ApprovalImportAuthorityError';
  }
}

/** Throws ApprovalImportAuthorityError unless `userId` may import open bills (or invoices) into this company now. */
export async function assertMayImportOpenBills(companyId: string, userId: string,
  documentType: ImportedDocumentType = 'supplier_invoice'): Promise<void> {
  if (!(await isEnforced(companyId, documentType))) return;
  const ruleRole = await strictestActiveRuleRole(companyId, documentType);
  if (ruleRole === null) return;
  const [member] = (await sql`
    SELECT role FROM company_users WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
  `) as { role: string | null }[];
  const role = member?.role ?? null;
  if (role !== null && actorRank(role) >= requiredRank(ruleRole)) return;
  log.warn('Import of open bills refused past approval enforcement', { companyId, userId, role, ruleRole, documentType }, 'accounting');
  throw new ApprovalImportAuthorityError(role, ruleRole, documentType);
}

export interface ApprovalGateImporter {
  companyId: string;
  userId: string;
  /** The bill (or invoice) enters the AP (or AR) population owing money (not fully paid). */
  open: boolean;
  /** What is imported, for the rank check. Default 'supplier_invoice'. */
  documentType?: ImportedDocumentType;
}

export async function withApprovalGateExempt<T>(importer: ApprovalGateImporter, write: () => Promise<T>): Promise<T> {
  // The GUC is transaction-local: with no request transaction it would last one
  // autocommit statement and the write would run unexempt (review LOW-4).
  if (!als.getStore()?.client) {
    throw new Error('withApprovalGateExempt must run inside a request transaction (withAuth, or an ALS-bound client).');
  }
  if (importer.open) await assertMayImportOpenBills(importer.companyId, importer.userId, importer.documentType);
  return withSavepoint('approval_gate_exempt', async () => {
    await sql`SELECT set_config('isaflow.approval_gate_exempt', 'import', true)`;
    const result = await write();
    await sql`SELECT set_config('isaflow.approval_gate_exempt', '', true)`;
    return result;
  });
}
