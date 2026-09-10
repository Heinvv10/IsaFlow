/**
 * Guards for MUTATING an approval rule.
 *
 * assertMayDecide (approvalAuthority.ts) reads `approval_rules.approver_role`
 * live, at decide time. That authority is therefore only worth what the write
 * path to the rule is worth — and `/api/accounting/approval-rules` is gated by
 * DEFAULT_WRITE_ROLES, so an admin facing a pending request under an owner-only
 * rule could lower the rule's role to their own, or deactivate it outright, and
 * then satisfy the rank comparison. A separation-of-duties control whose
 * parameters its subjects can edit is not one.
 *
 * So: you may not change or delete a rule that demands more authority than you
 * hold, you may not CREATE one (or raise/lower an existing one) at a rank you
 * could not exercise yourself, and every rule change writes an audit row
 * (approval_rules has no updated_by and the table kept no history at all).
 *
 * The create half is not decoration. Blocking PUT and DELETE alone leaves the
 * admin who cannot weaken an owner-only rule free to POST a second, manager-level
 * rule for the same document type — which is why `assertMayDemand` guards the
 * INCOMING role on every write, not just the stored one.
 */

import { sql } from '@/lib/neon';
import { actorRank, requiredRank } from './approvalAuthority';
import { logAuditOrThrow, type AuditFieldChange } from '../core/auditTrailService';

/** Who is editing, as withAuth established it — never as the caller claimed it. */
export interface RuleActor {
  userId: string;
  /** company_users.role for this company. */
  role: string;
  email?: string;
}

export class ApprovalRuleAuthorityError extends Error {
  readonly code = 'RULE_AUTHORITY_REQUIRED';

  constructor(ruleRole: string) {
    super(`This rule requires the ${ruleRole} role; you do not hold it, so you cannot create, change or delete it`);
    this.name = 'ApprovalRuleAuthorityError';
  }
}

/** The columns a rule change is worth recording. `id`/timestamps are not. */
const AUDITED_FIELDS = [
  'name', 'document_type', 'condition_field', 'condition_operator',
  'condition_value', 'approver_role', 'is_active', 'priority',
] as const;

const cell = (row: Record<string, unknown> | null, field: string): string | null =>
  row == null || row[field] == null ? null : String(row[field]);

function fieldChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditFieldChange[] {
  const changes: AuditFieldChange[] = [];
  for (const field of AUDITED_FIELDS) {
    const old = cell(before, field);
    const next = cell(after, field);
    if (old !== next) changes.push({ field, old, new: next, label: field });
  }
  return changes;
}

/**
 * Refuses when `actor` ranks below the authority a rule is about to DEMAND.
 * A rule is a separation-of-duties parameter, so nobody may set one to a rank
 * they do not themselves hold: an admin can neither mint an owner-only rule nor
 * hand one down to `viewer`. Synchronous — it ranks two strings and touches no
 * row, so `createRule` can call it before its INSERT.
 */
export function assertMayDemand(actor: RuleActor, ruleRole: string | undefined): void {
  if (ruleRole === undefined) return;
  if (actorRank(actor.role) < requiredRank(ruleRole)) {
    throw new ApprovalRuleAuthorityError(ruleRole);
  }
}

/**
 * Refuses when `actor` ranks below the rule's current `approver_role`, and
 * returns the row so the caller can record what it looked like before.
 * Returns null when the id names no rule this company can see — the caller
 * reports that (a 404), this guard does not turn it into a 403.
 */
export async function assertMayEditRule(
  companyId: string,
  ruleId: string,
  actor: RuleActor,
): Promise<Record<string, unknown> | null> {
  const rows = (await sql`
    SELECT * FROM approval_rules WHERE id = ${ruleId}::UUID AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) return null;

  // Same fallback as the decide path: an unrecognised role means 'admin', the
  // column default, rather than 0 — which would make every unknown role editable
  // by anybody who can reach the route.
  const ruleRole = row.approver_role != null ? String(row.approver_role) : 'admin';
  if (actorRank(actor.role) < requiredRank(ruleRole)) {
    throw new ApprovalRuleAuthorityError(ruleRole);
  }
  return row;
}

/**
 * Records a rule create/update/delete. Deliberately `logAuditOrThrow`, not the
 * fire-and-forget `logAudit`: an unrecorded weakening of an SoD control is the
 * thing this exists to prevent, so failing to record it must fail the write.
 */
export async function auditRuleChange(
  companyId: string,
  actor: RuleActor,
  action: 'create' | 'update' | 'delete',
  ruleId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  const named = after ?? before;
  await logAuditOrThrow({
    companyId,
    userId: actor.userId,
    userEmail: actor.email,
    action,
    entityType: 'approval_rule',
    entityId: ruleId,
    entityRef: named?.name != null ? String(named.name) : undefined,
    changes: { fields: fieldChanges(before, after), metadata: { actorRole: actor.role } },
  });
}
