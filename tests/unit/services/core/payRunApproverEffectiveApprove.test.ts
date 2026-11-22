/**
 * #1670 Codex (memberWrites:130): the last-other-approver guard (payRunApproverGuard) judges who can decide a pending pay run
 * by EFFECTIVE Payroll Approve (memberMay), not by role alone, and the permission writes take it too: withholding Approve,
 * unticking Payroll Approve, or a reset to a default without it is refused (409) while it would leave the requester alone.
 * The member writes and the guard run for real here, over a client that answers their queries from a table in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type M = { user_id: string; role: string; in_good_standing: boolean; approve_withheld: boolean; has_row: boolean; can_approve: boolean | null };
const db = vi.hoisted(() => ({ pending: true, members: [] as Array<Record<string, unknown>>, calls: [] as string[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: vi.fn(async (_n: string, fn: (c: unknown) => Promise<unknown>) => fn({
    query: vi.fn(async (text: string) => {
      db.calls.push(text);
      if (/SELECT role, public.company_member_role_is_owner/.test(text)) {
        return { rows: [{ role: 'manager', is_owner: false, is_target: true, is_actor: false }, { role: 'owner', is_owner: false, is_target: false, is_actor: true }] };
      }
      if (/FROM approval_requests ar/.test(text)) {
        return { rows: db.pending ? [{ id: 'req-1', requested_by: REQUESTER, required_role: null, rule_role: 'manager', authors: [] }] : [] };
      }
      if (/FROM company_users cu LEFT JOIN users u/.test(text)) return { rows: db.members };
      if (/SELECT id::TEXT AS id, approve_withheld/.test(text)) return { rows: [{ id: 'membership-1', approve_withheld: false }] };
      return { rows: [] };
    }),
  })),
}));

import { resetMemberPermissions, setMemberApproveWithheld, setMemberModulePermission, updateCompanyUserRole } from '@/modules/accounting/services/core/memberWrites';
import { PayRunApproverProtectedError } from '@/modules/accounting/services/core/payRunApproverGuard';

const C = '11111111-1111-4111-8111-111111111111';
const REQUESTER = 'requester-1';
const TARGET = 'target-1';
const OTHER = 'other-1';
const ACTOR = 'actor-1';
const member = (user_id: string, over: Partial<M> = {}): M => ({
  user_id, role: 'manager', in_good_standing: true, approve_withheld: false, has_row: false, can_approve: null, ...over,
});
const wrote = () => db.calls.some((t) => /UPDATE company_users|INSERT INTO company_user_permissions|DELETE FROM company_user_permissions/.test(t));

beforeEach(() => {
  db.pending = true;
  db.calls.length = 0;
  db.members = [member(REQUESTER, { role: 'admin' }), member(TARGET), member(OTHER)];
});

describe('the guard counts only members with effective Payroll Approve', () => {
  it('another manager whose Payroll Approve is unticked (row) or withheld is no other approver: demoting the target is refused', async () => {
    db.members[2] = member(OTHER, { has_row: true, can_approve: false });
    await expect(updateCompanyUserRole(C, TARGET, 'viewer', ACTOR)).rejects.toBeInstanceOf(PayRunApproverProtectedError);
    db.members[2] = member(OTHER, { approve_withheld: true });
    await expect(updateCompanyUserRole(C, TARGET, 'viewer', ACTOR)).rejects.toBeInstanceOf(PayRunApproverProtectedError);
    expect(wrote()).toBe(false);
    db.members[2] = member(OTHER); // the default: Approve
    await expect(updateCompanyUserRole(C, TARGET, 'viewer', ACTOR)).resolves.toBeUndefined();
  });
});

describe('permission writes that take the target\'s Payroll Approve away', () => {
  const onlyTarget = () => { db.members[2] = member(OTHER, { role: 'viewer' }); };

  it('withholding Approve from the last other approver is refused, nothing written; restoring it is not judged', async () => {
    onlyTarget();
    await expect(setMemberApproveWithheld(C, TARGET, true, ACTOR)).rejects.toBeInstanceOf(PayRunApproverProtectedError);
    expect(wrote()).toBe(false);
    await expect(setMemberApproveWithheld(C, TARGET, false, ACTOR)).resolves.toBeUndefined();
  });

  it('unticking Payroll Approve is refused; ticking it, or another module, is not', async () => {
    onlyTarget();
    await expect(setMemberModulePermission(C, TARGET, 'payroll', { canRead: true, canWrite: true, canApprove: false }, ACTOR))
      .rejects.toBeInstanceOf(PayRunApproverProtectedError);
    expect(wrote()).toBe(false);
    await expect(setMemberModulePermission(C, TARGET, 'payroll', { canApprove: true }, ACTOR)).resolves.toBeUndefined();
    await expect(setMemberModulePermission(C, TARGET, 'suppliers', { canApprove: false }, ACTOR)).resolves.toBeUndefined();
  });

  it('a reset to a default without Payroll Approve (withheld membership, approve granted by a row) is refused', async () => {
    onlyTarget();
    db.members[1] = member(TARGET, { approve_withheld: true, has_row: true, can_approve: true });
    await expect(resetMemberPermissions(C, TARGET, ACTOR)).rejects.toBeInstanceOf(PayRunApproverProtectedError);
    expect(wrote()).toBe(false);
    db.members[1] = member(TARGET, { has_row: true, can_approve: true }); // default manager: still approves after the reset
    await expect(resetMemberPermissions(C, TARGET, ACTOR)).resolves.toBeUndefined();
  });

  it('with another effective approver, or nothing pending, every one of them goes through', async () => {
    await expect(setMemberApproveWithheld(C, TARGET, true, ACTOR)).resolves.toBeUndefined();
    onlyTarget();
    db.pending = false;
    await expect(setMemberModulePermission(C, TARGET, 'payroll', { canApprove: false }, ACTOR)).resolves.toBeUndefined();
  });
});
