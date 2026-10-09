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
 * (approval_rules has no updated_by and the table kept no history at all) —
 * written by the rule definers of migration 881 (R-035 N1b B), which repeat
 * every guard here in SQL; approvalRuleWrites.ts is the only caller.
 *
 * The create half is not decoration. Blocking PUT and DELETE alone leaves the
 * admin who cannot weaken an owner-only rule free to POST a second, manager-level
 * rule for the same document type — which is why `assertMayDemand` guards the
 * INCOMING role on every write, not just the stored one.
 *
 * WEAKENING a rule takes more than holding its rank (R-048). "At or above" let
 * an admin hand an admin-level rule down to manager, withdraw their request and
 * re-raise it: the new request snapshotted the lowered role and a manager
 * approved it. Lowering the role, deactivating, deleting, or narrowing the
 * amounts a rule matches now needs a rank STRICTLY ABOVE the rule's current
 * level, so nobody can lower the level that governs them — except the owner,
 * the top of a company's ladder, who may weaken an owner-level rule (Hein):
 * otherwise nobody in the company could ever relax one.
 */

import { actorRank, requiredRank, APPROVER_RANK } from './approvalAuthority';
import { mayDemandRole } from './approvalRank';
import { lockRuleRow } from './approvalRuleWrites';

/** Who is editing, as withAuth established it — never as the caller claimed it. */
export interface RuleActor {
  userId: string;
  /** company_users.role for this company. */
  role: string;
  email?: string;
}

/**
 * Which refusal: the actor ranks below the rule at all, or holds its rank but
 * not the rank ABOVE it that weakening needs (R-048). `code` stays the same for
 * both so existing consumers and the MCP refusal allowlist are unaffected.
 */
export type ApprovalRuleAuthorityReason = 'RANK_REQUIRED' | 'WEAKENING_REQUIRES_HIGHER_RANK';

export class ApprovalRuleAuthorityError extends Error {
  readonly code = 'RULE_AUTHORITY_REQUIRED';
  readonly reason: ApprovalRuleAuthorityReason;

  constructor(ruleRole: string, weakening = false) {
    super(weakening
      ? `Only a role above ${ruleRole} can lower, deactivate, delete or narrow this ${ruleRole}-level rule`
      : `This rule requires the ${ruleRole} role; you do not hold it, so you cannot create, change or delete it`);
    this.name = 'ApprovalRuleAuthorityError';
    this.reason = weakening ? 'WEAKENING_REQUIRES_HIGHER_RANK' : 'RANK_REQUIRED';
  }
}

/**
 * May `actorRole` WEAKEN a control set at `ruleRole` (R-048)? Holding the rank
 * is not enough: it takes a rank STRICTLY ABOVE, so nobody can lower the level
 * that governs them — except at owner level, where nobody in a company ranks
 * above the owner, so at-or-above suffices. The one predicate for every
 * weakening act: rule edits here, and switching approval enforcement off
 * (approvalEnforcement.disableEnforcement).
 */
export function mayWeakenAtLevel(actorRole: string, ruleRole: string): boolean {
  const rank = actorRank(actorRole);
  const ruleRank = requiredRank(ruleRole);
  return ruleRank === APPROVER_RANK.owner ? rank >= ruleRank : rank > ruleRank;
}

/** The fields of an update that can move a rule's authority, or a delete. */
export type RuleChange = 'delete' | Partial<{
  approverRole: string;
  isActive: boolean;
  conditionOperator: string;
  conditionValue: number;
}>;

/**
 * The lowest amount a rule matches, and whether that bound is inclusive. `any`
 * and an operator checkApproval cannot read (it fails closed) match everything.
 */
function lowerBound(operator: string, value: number): { from: number; inclusive: boolean } {
  if (operator === 'greater_than') return { from: value, inclusive: false };
  if (operator === 'greater_equal') return { from: value, inclusive: true };
  return { from: -Infinity, inclusive: true };
}

/**
 * True when `change` would make the rule demand less: a lower role, off, gone,
 * or matching an amount set that no longer covers every amount it covered.
 * Judged on the fields even when the rule is inactive — a pending row raised
 * before migration 669 has no snapshot and still reads the bound rule's role.
 */
export function weakensRule(before: Record<string, unknown>, change: RuleChange): boolean {
  if (change === 'delete') return true;
  const ruleRole = before.approver_role != null ? String(before.approver_role) : 'admin';
  if (change.approverRole !== undefined && requiredRank(change.approverRole) < requiredRank(ruleRole)) return true;
  if (change.isActive === false) return true;

  const was = lowerBound(String(before.condition_operator), Number(before.condition_value ?? 0));
  const next = lowerBound(
    change.conditionOperator ?? String(before.condition_operator),
    Number(change.conditionValue ?? before.condition_value ?? 0),
  );
  // Narrowed when the new bound starts later, or at the same point but now
  // excludes the amount the old one included.
  return next.from > was.from || (next.from === was.from && was.inclusive && !next.inclusive);
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
  // mayDemandRole is also what the rule form offers roles by (approvalRank.ts).
  if (!mayDemandRole(actor.role, ruleRole)) {
    throw new ApprovalRuleAuthorityError(ruleRole);
  }
}

/**
 * Refuses when `actor` ranks below the rule's current `approver_role` — or, for
 * a `change` that weakens the rule, does not rank strictly ABOVE it (an owner
 * may weaken an owner-level rule: nobody in a company ranks above them) — and
 * returns the row so the caller can record what it looked like before.
 * Returns null when the id names no rule this company can see — the caller
 * reports that (a 404), this guard does not turn it into a 403.
 *
 * FOR UPDATE: the level ranked must be the one the write overwrites. Read
 * unlocked, an owner's in-flight raise of a manager rule to admin was invisible,
 * the admin's lowering passed against 'manager', and then landed on 'admin'.
 * The lock is approval_rule_lock (881): app_user may no longer lock the table.
 */
export async function assertMayEditRule(
  companyId: string,
  ruleId: string,
  actor: RuleActor,
  change: RuleChange,
): Promise<Record<string, unknown> | null> {
  const row = await lockRuleRow(companyId, ruleId, actor);
  if (!row) return null;

  // Same fallback as the decide path: an unrecognised role means 'admin', the
  // column default, rather than 0 — which would make every unknown role editable
  // by anybody who can reach the route.
  const ruleRole = row.approver_role != null ? String(row.approver_role) : 'admin';
  if (actorRank(actor.role) < requiredRank(ruleRole)) {
    throw new ApprovalRuleAuthorityError(ruleRole);
  }
  // At or above suffices only on an owner-level rule: nobody in a company ranks
  // above the owner. Every other level needs a rank strictly above it.
  if (weakensRule(row, change) && !mayWeakenAtLevel(actor.role, ruleRole)) {
    throw new ApprovalRuleAuthorityError(ruleRole, true);
  }
  return row;
}
