/**
 * K-043 (review L1): the approval decide path ranks roles with its own ladder
 * rather than ROLE_HIERARCHY, because ROLE_HIERARCHY has no 'accountant' or
 * 'user' key and its `?? 0` fallback would let anybody satisfy a rule whose
 * approver_role is 'accountant' — one of migration 234's seeded defaults.
 *
 * Two maps that nobody keeps in step will drift. These tests lock the ladder
 * against ROLE_HIERARCHY's ORDERING (not its numbers, which differ by design
 * because the ladder has to make room for the extra roles) and against the
 * company_users.role values the ladder must cover.
 */
import { describe, it, expect } from 'vitest';
import { ROLE_HIERARCHY } from '@/lib/auth/types';
import { APPROVER_RANK, APPROVER_ROLES, isApproverRole } from '@/modules/accounting/services/gl/approvalAuthority';

const sharedRoles = Object.keys(ROLE_HIERARCHY);

describe('APPROVER_RANK vs ROLE_HIERARCHY', () => {
  it('covers every role ROLE_HIERARCHY knows', () => {
    for (const role of sharedRoles) expect(APPROVER_RANK).toHaveProperty(role);
  });

  it('covers the company_users.role values ROLE_HIERARCHY omits', () => {
    // 'user' is the column default (migration 236); 'accountant' is an
    // approver_role seeded by migration 234.
    expect(APPROVER_RANK.user).toBeTypeOf('number');
    expect(APPROVER_RANK.accountant).toBeTypeOf('number');
  });

  it('orders every shared pair of roles the same way in both maps', () => {
    for (const a of sharedRoles) {
      for (const b of sharedRoles) {
        expect(Math.sign(APPROVER_RANK[a]! - APPROVER_RANK[b]!))
          .toBe(Math.sign(ROLE_HIERARCHY[a as keyof typeof ROLE_HIERARCHY] - ROLE_HIERARCHY[b as keyof typeof ROLE_HIERARCHY]));
      }
    }
  });

  it('ranks the extra roles below manager and above viewer', () => {
    expect(APPROVER_RANK.accountant!).toBeLessThan(APPROVER_RANK.manager!);
    expect(APPROVER_RANK.user!).toBeGreaterThan(APPROVER_RANK.viewer!);
    expect(APPROVER_RANK.accountant!).toBeGreaterThan(APPROVER_RANK.viewer!);
  });

  it('exposes exactly the ladder keys as the roles a rule may demand', () => {
    expect([...APPROVER_ROLES].sort()).toEqual(Object.keys(APPROVER_RANK).sort());
    expect(isApproverRole('owner')).toBe(true);
    expect(isApproverRole('Owner')).toBe(false);
    expect(isApproverRole('toString')).toBe(false);
  });
});
