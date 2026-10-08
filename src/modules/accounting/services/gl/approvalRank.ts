/**
 * The approver rank ladder (moved out of approvalAuthority.ts, R-035 follow-up
 * PR A). Pure: no database, no server import, so the rule form can offer the
 * roles an actor may demand on the very ladder the guards rank with.
 */

// Rank ladder for approver authority. ROLE_HIERARCHY in @/lib/auth/types has no
// entry for 'accountant', 'bookkeeper' or 'user', and its `?? 0` fallback would
// let anybody satisfy a rule whose approver_role is 'accountant' — one of the
// defaults seeded by migration 234. The roles a company can actually hold come
// from two allowlists: ALLOWED_COMPANY_ROLES in adminUserActionsService and the
// invitation route's own list. Every one of them must appear here, or the person
// holding it can never approve anything.
// tests/unit/services/gl/approverRankLadder.test.ts locks this ladder's ordering
// against ROLE_HIERARCHY and its coverage against both allowlists.
export const APPROVER_RANK: Record<string, number> = {
  super_admin: 8,
  owner: 7,
  system: 6,
  admin: 5,
  manager: 4,
  accountant: 3,
  bookkeeper: 2,
  storeman: 1,
  technician: 1,
  user: 1,
  viewer: 0,
};

/** Roles a rule may demand. Anything else is a typo that would silently mean admin. */
export const APPROVER_ROLES = Object.keys(APPROVER_RANK);
export const isApproverRole = (value: unknown): value is string =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(APPROVER_RANK, value);

// Both helpers go through isApproverRole rather than indexing and falling back on
// `??`: APPROVER_RANK is a plain object, so APPROVER_RANK['toString'] is a
// function, not undefined, and neither fallback would fire — the comparison
// would then be NaN < NaN, which is false, and the decision would be allowed.

/**
 * An unrecognised rule role falls back to 'admin', the column default in 234.
 * Exported because approvalRuleGuards ranks the same two things when deciding
 * who may EDIT a rule — one ladder, not a second copy that can drift.
 */
export const requiredRank = (role: string): number =>
  isApproverRole(role) ? APPROVER_RANK[role]! : APPROVER_RANK.admin!;

/** An unrecognised actor role carries no authority. */
export const actorRank = (role: string): number =>
  isApproverRole(role) ? APPROVER_RANK[role]! : 0;

/**
 * May `actorRole` set a rule to demand `ruleRole`? The predicate behind
 * assertMayDemand (approvalRuleGuards.ts): nobody may demand a rank above their
 * own. The rule form offers exactly the roles for which this is true.
 */
export const mayDemandRole = (actorRole: string, ruleRole: string): boolean =>
  actorRank(actorRole) >= requiredRank(ruleRole);

/**
 * Ladder roles the rule form never offers: `system` is a pseudo-role for
 * service accounts — no person holds or picks it (R-035 follow-up PR A review
 * round 1). The server still accepts it; this narrows only what is offered.
 */
const NOT_OFFERED = new Set(['system']);

/** The approver roles the rule form offers `actorRole`: those it may demand, strictest first. */
export const demandableApproverRoles = (actorRole: string): string[] =>
  APPROVER_ROLES.filter((role) => !NOT_OFFERED.has(role) && mayDemandRole(actorRole, role))
    .sort((a, b) => APPROVER_RANK[b]! - APPROVER_RANK[a]!);
