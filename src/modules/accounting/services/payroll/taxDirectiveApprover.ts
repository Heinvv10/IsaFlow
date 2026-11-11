/**
 * Four eyes on approving a tax directive, lump sum or regular pay (Hein's ruling, #1266 round 2).
 *
 * The person who captured a directive (`requested_by`) may not approve it while the company has ANOTHER member who could:
 * an owner, admin or manager (the payroll roles, DEFAULT_WRITE_ROLES) in good standing, read through the R-035 definer
 * approval_company_other_members (migration 708; it answers only for the caller in its own company). A company
 * with no such other member may self-approve; the approval's audit row then says so (`selfApproval: 'sole_approver'`,
 * the pay-run wording). Every approval writes that `approve` audit row in the same transaction as the status change.
 * Judged by person (ids compared case-folded), before the write; the refusal is a 403 (TaxDirectiveSelfApprovalError).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { DEFAULT_WRITE_ROLES } from '@/lib/auth/writeRoles';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';

export class TaxDirectiveSelfApprovalError extends Error {
  readonly code = 'TAX_DIRECTIVE_SELF_APPROVAL';
  constructor() {
    super('You captured this directive, so another owner, admin or manager must approve it.');
    this.name = 'TaxDirectiveSelfApprovalError';
  }
}

/** Whether `approverId` approving directive `id` is a self-approval; throws when another member could approve instead. */
export async function judgeDirectiveApprover(companyId: string, id: string, approverId: string): Promise<{ selfApproval: boolean }> {
  const row = ((await sql`
    SELECT requested_by::text AS requested_by FROM tax_directives WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid
  `) as DbRow[])[0];
  const creator = row?.requested_by == null ? null : String(row.requested_by).toLowerCase();
  if (creator !== approverId.toLowerCase()) return { selfApproval: false };
  // The company's other members through the R-035 definer (users is RLS-scoped to oneself: a plain join sees nobody),
  // in good standing (isActiveUserAccount: active, not suspended).
  const others = (await sql`
    SELECT m.role, m.is_active, m.status, m.suspended_at FROM approval_company_other_members(${companyId}::uuid, ${approverId}::text) m
  `) as Array<{ role: string; is_active: boolean | null; status: string | null; suspended_at: string | null }>;
  const writers: readonly string[] = DEFAULT_WRITE_ROLES;
  if (others.some(m => writers.includes(String(m.role)) && isActiveUserAccount(m))) throw new TaxDirectiveSelfApprovalError();
  return { selfApproval: true };
}

/** The approval's audit row, written on the request's transaction (it commits or rolls back with the status change). */
export async function auditDirectiveApproval(companyId: string, id: string, userId: string, selfApproval: boolean): Promise<void> {
  await logAuditOrThrow({
    companyId, userId, action: 'approve', entityType: 'tax_directive', entityId: id,
    changes: { fields: [], metadata: { status: 'approved', ...(selfApproval ? { selfApproval: 'sole_approver' } : {}) } },
  });
}
