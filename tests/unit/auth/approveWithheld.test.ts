/**
 * #1656 round 3 (H1, 17, M2): the withheld Approve / Payroll of a former accountant / bookkeeper lives on the membership
 * (company_users.approve_withheld, migration 1010c), so "Reset to defaults" and a permission module added later cannot bring
 * the full manager default back; a viewer keeps no Approve through rows that outlived a demotion; and a group's Approve needs a
 * write role AND the permission in the SAME member company, in one query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { checkGroupPermission, checkPermission, getEffectivePermissions } from '@/lib/auth/permissionService';
import { roleDefaultPermission } from '@/lib/auth/companyRoles';

const C = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const U = '99999999-9999-4999-8999-999999999999';
const G = '80000000-0000-4000-8000-000000000001';
let db = permissionDb();
const key = (c = C) => `${c}:${U}`;

beforeEach(() => {
  db = permissionDb();
  vi.mocked(sql).mockImplementation(permissionSql(db) as never);
});

describe('roleDefaultPermission with approveWithheld', () => {
  it('a withheld manager has no Approve on any module and nothing on Payroll; the rest of the manager default stands', () => {
    for (const m of ['suppliers', 'accounts', 'budgets', 'a_module_added_later']) {
      expect(roleDefaultPermission('manager', 'approve', m, true)).toBe(false);
      expect(roleDefaultPermission('manager', 'write', m, true)).toBe(true);
    }
    expect(roleDefaultPermission('manager', 'read', 'payroll', true)).toBe(false);
    expect(roleDefaultPermission('manager', 'write', 'payroll', true)).toBe(false);
    expect(roleDefaultPermission('manager', 'approve', 'suppliers', false)).toBe(true);
    expect(roleDefaultPermission('admin', 'approve', 'payroll', true)).toBe(true); // the flag never weakens an admin
  });
});

describe('a migrated user (manager, approve_withheld) after the rows are gone', () => {
  beforeEach(() => { db.members.set(key(), 'manager'); db.withheld.add(key()); });

  it('Reset to defaults (no rows) still refuses Approve on every module and Payroll read / write', async () => {
    for (const m of ['suppliers', 'customers', 'accounts', 'budgets']) expect(await checkPermission(C, U, m, 'approve')).toBe(false);
    expect(await checkPermission(C, U, 'payroll', 'read')).toBe(false);
    expect(await checkPermission(C, U, 'payroll', 'write')).toBe(false);
    expect(await checkPermission(C, U, 'suppliers', 'write')).toBe(true);
  });

  it('a permission module added later (no row for it) stays denied', async () => {
    expect(await checkPermission(C, U, 'module_added_in_2027', 'approve')).toBe(false);
  });

  it('an owner who ticks Approve (a row) grants it: a row overrides the default', async () => {
    db.rows.set(`${key()}:suppliers`, { can_read: true, can_write: true, can_approve: true });
    expect(await checkPermission(C, U, 'suppliers', 'approve')).toBe(true);
    expect(await checkPermission(C, U, 'customers', 'approve')).toBe(false);
  });

  it('the grids show the withheld default (approve off, Payroll off) with no rows', async () => {
    vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
      const t = strings.join('?');
      if (t.includes('FROM permission_modules')) return [{ module_key: 'suppliers', module_name: 'Suppliers' }, { module_key: 'payroll', module_name: 'Payroll' }];
      return [];
    }) as never);
    const perms = await getEffectivePermissions(C, U, 'manager', true);
    expect(perms.find((p) => p.moduleKey === 'suppliers')).toMatchObject({ canWrite: true, canApprove: false });
    expect(perms.find((p) => p.moduleKey === 'payroll')).toMatchObject({ canRead: false, canWrite: false, canApprove: false });
  });

  it('a manager without the flag keeps the default (control)', async () => {
    db.withheld.clear();
    expect(await checkPermission(C, U, 'suppliers', 'approve')).toBe(true);
    expect(await checkPermission(C, U, 'payroll', 'write')).toBe(true);
  });
});

describe('a viewer keeps no Approve through rows that outlived a demotion', () => {
  it('a stale can_approve row on a viewer membership is refused; the other actions still follow the row', async () => {
    db.members.set(key(), 'viewer');
    db.rows.set(`${key()}:suppliers`, { can_read: true, can_write: true, can_approve: true });
    expect(await checkPermission(C, U, 'suppliers', 'approve')).toBe(false);
    expect(await checkPermission(C, U, 'suppliers', 'read')).toBe(true);
  });
});

describe('checkGroupPermission: a write role AND the permission in the SAME member company, one query', () => {
  beforeEach(() => { db.groups.set(G, [C, C2]); });

  it('a viewer with a stale approve row in A and a writer without Approve in B: refused (each half in a different company)', async () => {
    db.members.set(key(C), 'viewer');
    db.rows.set(`${key(C)}:group`, { can_read: true, can_write: true, can_approve: true });
    db.members.set(key(C2), 'manager');
    db.rows.set(`${key(C2)}:group`, { can_read: true, can_write: true, can_approve: false });
    expect(await checkGroupPermission(U, G, 'group', 'approve')).toBe(false);
  });

  it('a manager with Approve in one member company: allowed, however the other company is', async () => {
    db.members.set(key(C), 'viewer');
    db.members.set(key(C2), 'manager');
    expect(await checkGroupPermission(U, G, 'group', 'approve')).toBe(true);
  });

  it('a withheld manager in the only member company: refused; one query asked, not one per company', async () => {
    db.members.set(key(C), 'manager');
    db.withheld.add(key(C));
    vi.mocked(sql).mockClear();
    expect(await checkGroupPermission(U, G, 'group', 'approve')).toBe(false);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('a company that is not a current member of the group, or a user in none of them: refused', async () => {
    db.members.set(key('33333333-3333-4333-8333-333333333333'), 'owner');
    expect(await checkGroupPermission(U, G, 'group', 'approve')).toBe(false);
  });
});
