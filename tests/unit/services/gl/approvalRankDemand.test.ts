/**
 * R-035 follow-up, PR A: the rule form offers only the approver roles the actor
 * may DEMAND (Hein 2026-10-08 §2a.3: mirror assertMayDemand; the server stays
 * authoritative). The list is derived from the same ladder and the same
 * predicate as the guard, so for every pair of roles the form offers a role
 * exactly when the guard would accept it.
 */
import { describe, expect, it } from 'vitest';
import { demandableApproverRoles, mayDemandRole, APPROVER_RANK } from '@/modules/accounting/services/gl/approvalRank';
import { APPROVER_ROLES } from '@/modules/accounting/services/gl/approvalAuthority';
import { assertMayDemand } from '@/modules/accounting/services/gl/approvalRuleGuards';

const ACTORS = [...APPROVER_ROLES, 'Owner', 'toString', '', 'nobody'];

const guardAccepts = (actorRole: string, ruleRole: string): boolean => {
  try {
    assertMayDemand({ userId: 'u', role: actorRole }, ruleRole);
    return true;
  } catch {
    return false;
  }
};

describe('demandableApproverRoles', () => {
  it.each(ACTORS)('for a %s offers exactly the roles assertMayDemand accepts', (actorRole) => {
    const offered = demandableApproverRoles(actorRole);
    for (const ruleRole of APPROVER_ROLES) {
      expect(offered.includes(ruleRole), `${actorRole} → ${ruleRole}`).toBe(guardAccepts(actorRole, ruleRole));
      expect(mayDemandRole(actorRole, ruleRole)).toBe(guardAccepts(actorRole, ruleRole));
    }
  });

  it('never offers a role above the actor, strictest first', () => {
    expect(demandableApproverRoles('manager')).toEqual(['manager', 'accountant', 'bookkeeper', 'storeman', 'technician', 'user', 'viewer']);
    expect(demandableApproverRoles('owner')).not.toContain('super_admin');
    expect(demandableApproverRoles('admin')).not.toContain('owner');
    // An unrecognised actor role carries no authority (actorRank): only viewer.
    expect(demandableApproverRoles('Owner')).toEqual(['viewer']);
    const ranks = demandableApproverRoles('super_admin').map((r) => APPROVER_RANK[r]!);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });
});
