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
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// The two routes are probed, not read: a role their allow-list refuses is answered before any SQL;
// one it accepts reaches the database, which here throws PAST_THE_ALLOW_LIST.
vi.mock('@/lib/neon', () => ({ sql: vi.fn(() => { throw new Error('PAST_THE_ALLOW_LIST'); }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/withAuth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));

import { ROLE_HIERARCHY } from '@/lib/auth/types';
import { LEGACY_ROLE_MAP } from '@/lib/auth/companyRoles';
import { addUserToCompany, CompanyMembershipError } from '@/modules/admin/services/companyMembershipService';
import invitationsRoute from '../../../../pages/api/invitations/index';
import { VALID_ROLES as ACCESS_SERVICE_ROLES } from '@/modules/accounting/services/core/userAccessService';
import { VALID_ROLES as INVITATION_SERVICE_ROLES } from '@/modules/accounting/services/core/userInvitationService';
import { APPROVER_RANK, APPROVER_ROLES, isApproverRole } from '@/modules/accounting/services/gl/approvalAuthority';

const sharedRoles = Object.keys(ROLE_HIERARCHY);

/** Every value a role column has held or could be sent: the four, the legacy five, the platform two, junk. */
const CANDIDATES = ['owner', 'admin', 'manager', 'viewer', 'accountant', 'bookkeeper', 'storeman', 'technician', 'user',
  'super_admin', 'system', 'Owner', 'toString'];

/** The roles POST /api/invitations accepts: those not answered 400 'email and role required'. */
async function invitableRoles(): Promise<string[]> {
  const accepted: string[] = [];
  for (const role of CANDIDATES) {
    let status = 0;
    const res = { status(c: number) { status = c; return this; }, json() { return this; }, setHeader() { return this; } };
    const req = { method: 'POST', body: { email: 'a@b.test', role }, companyId: '11111111-1111-4111-8111-111111111111',
      companyRole: 'owner', user: { id: 'u' }, headers: {} } as unknown as NextApiRequest;
    await (invitationsRoute as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res as never).catch(() => undefined);
    if (status !== 400) accepted.push(role);
  }
  return accepted;
}

/** The roles the admin portal's add-to-company accepts: those not refused INVALID_ROLE. */
async function portalGrantableRoles(): Promise<string[]> {
  const accepted: string[] = [];
  for (const role of CANDIDATES) {
    const err = await addUserToCompany('u', '11111111-1111-4111-8111-111111111111', role).catch((e: unknown) => e);
    if (!(err instanceof CompanyMembershipError && err.code === 'INVALID_ROLE')) accepted.push(role);
  }
  return accepted;
}

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

  // A role a company can be given but the ladder does not know ranks 0, so that
  // person can never approve anything and is told the rule "requires the admin
  // role". 'bookkeeper' was exactly that until this test enumerated the source.
  it('covers every role the platform-admin route can assign (probed: admin, manager, viewer)', async () => {
    const roles = await portalGrantableRoles();
    expect(roles).toEqual(['admin', 'manager', 'viewer']);
    for (const role of roles) expect(APPROVER_RANK).toHaveProperty(role);
  });

  // Rows written before #1656 may still name a legacy role (an approval rule's approver_role, a
  // row the 1010 migration has not reached): each keeps a rank, so none silently ranks as nothing.
  it('still ranks every legacy role', () => {
    for (const role of Object.keys(LEGACY_ROLE_MAP)) expect(APPROVER_RANK).toHaveProperty(role);
  });

  it('covers every role the invitation route can assign (probed: admin, manager, viewer)', async () => {
    const roles = await invitableRoles();
    expect(roles).toEqual(['admin', 'manager', 'viewer']);
    for (const role of roles) expect(APPROVER_RANK).toHaveProperty(role);
  });

  /**
   * Four allowlists write company_users.role, not two. updateCompanyUserRole in
   * userAccessService is the route that actually changes a member's role in the
   * product, and adding a role to its list would not have failed this test.
   *
   * tenantProvisioningService.ts and the two invite-accept routes write the
   * column with no allowlist at all; they are enumerated in the K-043 fix
   * document rather than here, because there is no list to read.
   */
  it('covers every role the in-product access and invitation services can assign', () => {
    for (const role of ACCESS_SERVICE_ROLES) expect(APPROVER_RANK).toHaveProperty(role);
    for (const role of INVITATION_SERVICE_ROLES) expect(APPROVER_RANK).toHaveProperty(role);
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
    // The pre-#1656 portal list (admin, accountant, bookkeeper, viewer) was written in
    // descending authority, the only evidence there is for where a bookkeeper sits.
    expect(APPROVER_RANK.bookkeeper!).toBeLessThan(APPROVER_RANK.accountant!);
    expect(APPROVER_RANK.bookkeeper!).toBeGreaterThan(APPROVER_RANK.viewer!);
  });

  it('exposes exactly the ladder keys as the roles a rule may demand', () => {
    expect([...APPROVER_ROLES].sort()).toEqual(Object.keys(APPROVER_RANK).sort());
    expect(isApproverRole('owner')).toBe(true);
    expect(isApproverRole('Owner')).toBe(false);
    expect(isApproverRole('toString')).toBe(false);
  });
});
