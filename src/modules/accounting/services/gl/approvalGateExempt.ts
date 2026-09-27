/**
 * The declared import exemption from the supplier-invoice approval backstop
 * (R-035, decision Q1; migration 712's trigger reads it).
 *
 * The Sage staging import, the Sage migration commit and the AP take-on book
 * bills that were approved in the system they come from, straight into the AP
 * population. They — and only they — wrap that write in withApprovalGateExempt,
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
 * historic bill owes nothing and imports for anyone. The check runs here, in
 * the one wrapper, so no caller reaches the GUC around it; the importers also
 * call assertMayImportOpenBills up front, to refuse before their first write.
 *
 * In a savepoint so that a throw reverts the setting with the write
 * (ROLLBACK TO undoes a set_config made after the savepoint) instead of
 * leaving the rest of the transaction exempt.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { actorRank, requiredRank } from './approvalAuthority';
import { isEnforced, strictestActiveRuleRole } from './approvalEnforcement';

/** An import of open bills past enforcement, by a role below the strictest rule. Routes answer 403. */
export class ApprovalImportAuthorityError extends Error {
  readonly code = 'IMPORT_APPROVAL_AUTHORITY_REQUIRED';
  constructor(actorRole: string | null, ruleRole: string) {
    super(`Supplier-invoice approvals are enforced, so importing open (unpaid) bills needs the ${ruleRole} role or above `
      + `— the strictest active approval rule — and you hold ${actorRole ?? 'no role in this company'}. `
      + `Ask a ${ruleRole} to run the import, or import only fully paid bills.`);
    this.name = 'ApprovalImportAuthorityError';
  }
}

/** Throws ApprovalImportAuthorityError unless `userId` may import open bills into this company now. */
export async function assertMayImportOpenBills(companyId: string, userId: string): Promise<void> {
  if (!(await isEnforced(companyId, 'supplier_invoice'))) return;
  const ruleRole = await strictestActiveRuleRole(companyId, 'supplier_invoice');
  if (ruleRole === null) return;
  const [member] = (await sql`
    SELECT role FROM company_users WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
  `) as { role: string | null }[];
  const role = member?.role ?? null;
  if (role !== null && actorRank(role) >= requiredRank(ruleRole)) return;
  log.warn('Import of open bills refused past approval enforcement', { companyId, userId, role, ruleRole }, 'accounting');
  throw new ApprovalImportAuthorityError(role, ruleRole);
}

export interface ApprovalGateImporter {
  companyId: string;
  userId: string;
  /** The bill enters the AP population owing money (not fully paid). */
  open: boolean;
}

export async function withApprovalGateExempt<T>(importer: ApprovalGateImporter, write: () => Promise<T>): Promise<T> {
  if (importer.open) await assertMayImportOpenBills(importer.companyId, importer.userId);
  return withSavepoint('approval_gate_exempt', async () => {
    await sql`SELECT set_config('isaflow.approval_gate_exempt', 'import', true)`;
    const result = await write();
    await sql`SELECT set_config('isaflow.approval_gate_exempt', '', true)`;
    return result;
  });
}
