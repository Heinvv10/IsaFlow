/**
 * Four eyes on approving a tax directive, lump sum or regular pay (Hein's ruling, #1266 round 2).
 *
 * The person who captured a directive (`requested_by`) may not approve it while the company has ANOTHER member who could:
 * an owner, admin or manager (the payroll roles, DEFAULT_WRITE_ROLES) in good standing, read through the R-035 definer
 * approval_company_other_members (migration 708; it answers only for the caller in its own company). A company
 * with no such other member may self-approve; the approval's audit row then says so (`selfApproval: 'sole_approver'`,
 * the pay-run wording). Every approval writes that `approve` audit row in the same transaction as the status change.
 * The roster AS OF CAPTURE counts too (#1266 round 3 L-a): the members who could approve when the directive was created
 * (approvers_at_create, migration 977) block self-approval while their account is active, even if demoted since.
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
    super('You captured this directive, so another owner, admin or manager must approve it. If the member who could approve it '
      + 'when it was captured has since left the company, capture the directive again.');
    this.name = 'TaxDirectiveSelfApprovalError';
  }
}

/** Whether `approverId` approving directive `id` is a self-approval; throws when another member could approve instead. */
export async function judgeDirectiveApprover(companyId: string, id: string, approverId: string): Promise<{ selfApproval: boolean }> {
  const row = ((await sql`
    SELECT requested_by::text AS requested_by, approvers_at_create FROM tax_directives WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid
  `) as DbRow[])[0];
  const creator = row?.requested_by == null ? null : String(row.requested_by).toLowerCase();
  if (creator !== approverId.toLowerCase()) return { selfApproval: false };
  // The company's other members through the R-035 definer (users is RLS-scoped to oneself: a plain join sees nobody),
  // in good standing (isActiveUserAccount: active, not suspended).
  const others = (await sql`
    SELECT m.user_id, m.role, m.is_active, m.status, m.suspended_at FROM approval_company_other_members(${companyId}::uuid, ${approverId}::text) m
  `) as Array<{ user_id: string; role: string; is_active: boolean | null; status: string | null; suspended_at: string | null }>;
  const writers: readonly string[] = DEFAULT_WRITE_ROLES;
  // Roster as of capture (L-a): anyone who could approve then still blocks while their account is active, whatever their role
  // now; one whose membership was REMOVED since cannot be seen at all, so a removal counts as a demotion and blocks too (the
  // creator captures the directive again to start from today's roster).
  const atCreate = new Set(((row?.approvers_at_create ?? []) as string[]).map(u => u.toLowerCase()));
  const present = new Set(others.map(m => String(m.user_id).toLowerCase()));
  const blocks = (m: (typeof others)[number]) => isActiveUserAccount(m) && (writers.includes(String(m.role)) || atCreate.has(String(m.user_id).toLowerCase()));
  const removedSince = [...atCreate].some(u => !present.has(u));
  if (removedSince || others.some(blocks)) throw new TaxDirectiveSelfApprovalError();
  return { selfApproval: true };
}

/** The approval's audit row, written on the request's transaction (it commits or rolls back with the status change). */
export async function auditDirectiveApproval(companyId: string, id: string, userId: string, selfApproval: boolean): Promise<void> {
  await logAuditOrThrow({
    companyId, userId, action: 'approve', entityType: 'tax_directive', entityId: id,
    changes: { fields: [], metadata: { status: 'approved', ...(selfApproval ? { selfApproval: 'sole_approver' } : {}) } },
  });
}

/**
 * The company's other owner / admin / manager members with an active account, stored on the directive at capture
 * (approvers_at_create). Read through the R-035 definer approval_company_other_members, which sees the whole roster
 * whatever the creator's role (company_users RLS shows a manager only their own row). The definer answers only inside
 * the creator's own request; a caller with no request claims (a service context) reads company_users directly, which
 * that context sees whole.
 */
export async function approversAtCreate(companyId: string, creatorId: string): Promise<string[]> {
  const inRequest = ((await sql`
    SELECT NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL AS has_claims
  `) as DbRow[])[0]?.has_claims === true;
  const members = (inRequest
    ? await sql`SELECT m.user_id, m.role, m.is_active, m.status, m.suspended_at FROM approval_company_other_members(${companyId}::uuid, ${creatorId}::text) m`
    : await sql`
        SELECT cu.user_id, cu.role, TRUE AS is_active, NULL::text AS status, NULL::timestamptz AS suspended_at
        FROM company_users cu WHERE cu.company_id = ${companyId}::uuid AND lower(cu.user_id) <> ${creatorId.toLowerCase()}
      `) as Array<{ user_id: string; role: string; is_active: boolean | null; status: string | null; suspended_at: string | null }>;
  const writers: readonly string[] = DEFAULT_WRITE_ROLES;
  return members.filter(m => writers.includes(String(m.role)) && isActiveUserAccount(m)).map(m => String(m.user_id)).sort();
}
