/**
 * #1656 round 7 (breaker M4): company_user_permissions is written on the migration_admin pool (migration 1010d takes the app roles'
 * privileges), after an explicit owner / admin check in TypeScript: setMemberModulePermission and resetMemberPermissions refuse a
 * non-owner / non-admin actor, a target that is not a member, and an admin changing an owner's permissions, before any write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ text: string; values: unknown[] }>);
const members = vi.hoisted(() => ({ rows: [] as Array<{ role: string; is_owner: boolean; is_target: boolean; is_actor: boolean }> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: vi.fn(async (_n: string, fn: (c: unknown) => Promise<unknown>) => fn({
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/SELECT role, public.company_member_role_is_owner/.test(text)) return { rows: members.rows };
      return { rows: [] };
    }),
  })),
}));

import { MemberRoleForbiddenError, resetMemberPermissions, setMemberModulePermission } from '@/modules/accounting/services/core/memberWrites';
import { OwnerProtectedError } from '@/modules/accounting/services/core/ownerLock';

const C = '11111111-1111-4111-8111-111111111111';
const T = '99999999-9999-4999-8999-999999999999';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const PERMS = { canRead: true, canWrite: true, canApprove: true, accountRangeFrom: '1000', accountRangeTo: null };
const writes = () => calls.filter((c) => /INSERT INTO company_user_permissions|DELETE FROM company_user_permissions/.test(c.text));
const asMembers = (target: string, actor: string | null) => {
  members.rows = [{ role: target, is_owner: target === 'owner', is_target: true, is_actor: false }];
  if (actor) members.rows.push({ role: actor, is_owner: actor === 'owner', is_target: false, is_actor: true });
};

beforeEach(() => { calls.length = 0; });

describe('setMemberModulePermission', () => {
  it.each(['manager', 'viewer'])('an actor who is only a %s is refused (RC001), and nothing is written', async (actorRole) => {
    asMembers('manager', actorRole);
    await expect(setMemberModulePermission(C, T, 'suppliers', PERMS, ACTOR)).rejects.toBeInstanceOf(MemberRoleForbiddenError);
    expect(writes()).toEqual([]);
  });

  it('a caller who is no member of the company at all is refused, and nothing is written', async () => {
    asMembers('manager', null);
    await expect(setMemberModulePermission(C, T, 'suppliers', PERMS, ACTOR)).rejects.toBeInstanceOf(MemberRoleForbiddenError);
    expect(writes()).toEqual([]);
  });

  it('a target who is not a member of this company is refused (no phantom row)', async () => {
    members.rows = [{ role: 'admin', is_owner: false, is_target: false, is_actor: true }];
    await expect(setMemberModulePermission(C, T, 'suppliers', PERMS, ACTOR)).rejects.toThrow(/not a member/);
    expect(writes()).toEqual([]);
  });

  it("an admin cannot change an owner's permissions, an owner can", async () => {
    asMembers('owner', 'admin');
    await expect(setMemberModulePermission(C, T, 'suppliers', PERMS, ACTOR)).rejects.toBeInstanceOf(OwnerProtectedError);
    expect(writes()).toEqual([]);
    asMembers('owner', 'owner');
    await setMemberModulePermission(C, T, 'suppliers', PERMS, ACTOR);
    expect(writes()).toHaveLength(1);
  });

  it('an owner or admin writes the one row with every column the grid sets', async () => {
    asMembers('manager', 'admin');
    await setMemberModulePermission(C, T, 'suppliers', PERMS, ACTOR);
    const [w] = writes();
    expect(w!.values).toEqual([C, T, 'suppliers', true, true, false, false, true, '1000', null, '{}']);
    // the check precedes the write
    expect(calls.indexOf(w!)).toBeGreaterThan(calls.findIndex((c) => /company_member_role_is_owner/.test(c.text)));
  });
});

describe('resetMemberPermissions', () => {
  it('refuses a non-owner / non-admin actor before the DELETE; an admin deletes the member\'s rows in this company only', async () => {
    asMembers('manager', 'manager');
    await expect(resetMemberPermissions(C, T, ACTOR)).rejects.toBeInstanceOf(MemberRoleForbiddenError);
    expect(writes()).toEqual([]);
    asMembers('manager', 'admin');
    await resetMemberPermissions(C, T, ACTOR);
    expect(writes().map((w) => w.values)).toEqual([[C, T]]);
  });
});
