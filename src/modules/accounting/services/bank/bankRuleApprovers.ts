/**
 * WHO may decide (approve or reject) a held bank-rule change (forensic-controls
 * step 2; Hein's decision 3) — step 1's policy (ap/supplierBankVerifiers.ts)
 * with the proposer in the setter's place. Migration 877's decision guard
 * re-checks the admin floor and the sole-approver roster.
 *
 *  - The approver role (bankRuleApproverRole) is the strictest active
 *    manual_journal rule's role, never below the admin FLOOR.
 *  - Raised above the floor, it falls back to the floor when no member but
 *    the proposer holds it while the proposer does — otherwise an owner-level
 *    rule plus a sole owner's own proposal could never be decided.
 *  - The proposer decides only as R-035's sole approver: no OTHER active
 *    member reaches the floor (judged on the floor, never the raised role).
 *    Recorded with the roster snapshot.
 *  - The decider's role and standing are read from the database, not taken
 *    from the caller.
 */
import { bankRuleApproverRole } from '../gl/approvalEnforcement';
import { actorRank, requiredRank } from '../gl/approvalRank';
import { ownCompanyRole } from '../ap/supplierBankBaseline';
import { BANK_CONTROL_FLOOR, BankControlError, isHumanSession, isSoleAtFloor, otherActiveMembers, rosterSnapshot } from './bankControlRefusal';

const holds = (role: string | undefined | null, level: string) => role != null && actorRank(role) >= requiredRank(level);

/** The company facts one decision (or one listing) needs, read once. */
export async function approverFacts(companyId: string, userId: string) {
  const ownRole = await ownCompanyRole(companyId, userId);
  const approverRole = await bankRuleApproverRole(companyId);
  const others = await otherActiveMembers(companyId, userId);
  return { userId, ownRole, approverRole, others };
}
type Facts = Awaited<ReturnType<typeof approverFacts>>;

/** The role a decider of `proposedBy`'s change needs now. */
function requiredRole(f: Facts, proposedBy: string): string {
  if (requiredRank(f.approverRole) <= requiredRank(BANK_CONTROL_FLOOR)) return f.approverRole;
  const everyone = [...f.others, { userId: f.userId, role: f.ownRole ?? '' }];
  const someoneElseHolds = everyone.some((m) => m.userId !== proposedBy && holds(m.role, f.approverRole));
  const proposerHolds = holds(everyone.find((m) => m.userId === proposedBy)?.role, f.approverRole);
  return !someoneElseHolds && proposerHolds ? BANK_CONTROL_FLOOR : f.approverRole;
}

/** Throws BankControlError unless the facts' user may decide; `sole`: no OTHER active member reaches the floor. */
function judge(f: Facts, proposedBy: string, sole: boolean): void {
  const role = requiredRole(f, proposedBy);
  if (!holds(f.ownRole, role)) {
    throw new BankControlError('APPROVER_ROLE_REQUIRED',
      `Deciding a bank-rule change needs the ${role} role or above — the role that approves manual journals.`);
  }
  if (f.userId === proposedBy && !sole) {
    throw new BankControlError('PROPOSER_MAY_NOT_DECIDE',
      'You proposed this change, so another member with the approver role must approve or reject it.');
  }
}

/**
 * Throws unless `userId` may decide `proposedBy`'s change; returns the roster
 * snapshot when they may only as the sole approver (their own change), else null.
 */
export async function assertMayDecide(companyId: string, proposedBy: string, userId: string): Promise<unknown> {
  const f = await approverFacts(companyId, userId);
  const own = userId === proposedBy;
  judge(f, proposedBy, own && await isSoleAtFloor(companyId, userId));
  return own ? rosterSnapshot(companyId, userId) : null;
}

/** For a listing: whether this viewer may decide a change by `proposedBy` (own session, and the policy passes). A hint; the POST decides. */
export async function decideHint(companyId: string, userId: string): Promise<(proposedBy: string) => boolean> {
  const f = await approverFacts(companyId, userId);
  const human = await isHumanSession();
  const sole = !f.others.some((m) => holds(m.role, BANK_CONTROL_FLOOR));
  return (proposedBy) => {
    if (!human) return false;
    try {
      judge(f, proposedBy, sole);
      return true;
    } catch (err) {
      if (err instanceof BankControlError) return false;
      throw err;
    }
  };
}
