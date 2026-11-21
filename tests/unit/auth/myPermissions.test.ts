/**
 * The caller's own effective module permissions (nav hiding for users without Payroll read): decided by the rule
 * the routes enforce (`memberMay`): stored role, the user's row for the module, else the role default
 * (approve_withheld honoured); owner/admin everything whatever a stray row says; not a member: nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { getMyModulePermissions } from '@/lib/auth/myPermissions';
import { checkPermission } from '@/lib/auth/permissionService';

const CO = '11111111-1111-4111-9111-111111111111';
const USER = '22222222-2222-4222-9222-222222222222';

type Mem = { role: string; withheld?: boolean; row?: { r: boolean; w: boolean; a: boolean } };
/** The one joined row the query returns per module for this member. */
function dbRow(moduleKey: string, m: Mem): Record<string, unknown> {
  return {
    module_key: moduleKey, role: m.role, approve_withheld: m.withheld === true,
    can_read: m.row?.r ?? null, can_write: m.row?.w ?? null, can_delete: false, can_export: false, can_approve: m.row?.a ?? null,
    has_row: Boolean(m.row),
  };
}
function member(m: Mem, rowOn: string[] = ['payroll']) {
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce(['customers', 'payroll'].map((k) => dbRow(k, rowOn.includes(k) ? m : { ...m, row: undefined })));
}
const NONE = { read: false, write: false, approve: false };

describe('getMyModulePermissions', () => {
  beforeEach(() => sqlMock.mockReset());

  it('a viewer with no row gets the role default: read, no write, no approve', async () => {
    member({ role: 'viewer' });
    expect((await getMyModulePermissions(CO, USER)).payroll).toEqual({ read: true, write: false, approve: false });
  });

  it('a row overrides the role default, per module', async () => {
    member({ role: 'manager', row: { r: false, w: false, a: false } });
    const out = await getMyModulePermissions(CO, USER);
    expect(out.payroll).toEqual(NONE);
    expect(out.customers.read).toBe(true);
    expect(out.customers.write).toBe(true);
  });

  it('owner and admin have every module whatever a row says', async () => {
    member({ role: 'admin', row: { r: false, w: false, a: false } });
    expect((await getMyModulePermissions(CO, USER)).payroll).toEqual({ read: true, write: true, approve: true });
  });

  it('a manager with approve_withheld (a former accountant) has no Payroll and no Approve by default', async () => {
    member({ role: 'manager', withheld: true });
    const out = await getMyModulePermissions(CO, USER);
    expect(out.payroll.read).toBe(false);
    expect(out.customers.approve).toBe(false);
  });

  it('a non-member has no rows, so no module', async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([]);
    expect(await getMyModulePermissions(CO, USER)).toEqual({});
  });

  it('agrees with checkPermission (what withPayrollModule enforces) for every role and row', async () => {
    const cases: Mem[] = [
      { role: 'owner' }, { role: 'admin', row: { r: false, w: false, a: false } }, { role: 'manager' }, { role: 'manager', withheld: true },
      { role: 'manager', row: { r: false, w: false, a: false } }, { role: 'viewer' }, { role: 'viewer', row: { r: true, w: true, a: true } },
      { role: 'viewer', row: { r: false, w: false, a: false } }, { role: 'stranger' },
    ];
    for (const m of cases) {
      member(m);
      const mine = (await getMyModulePermissions(CO, USER)).payroll;
      for (const [key, action] of [['read', 'read'], ['write', 'write'], ['approve', 'approve']] as const) {
        sqlMock.mockReset();
        sqlMock.mockResolvedValueOnce([{ ...dbRow('payroll', m), role: m.role }]);
        expect([JSON.stringify(m), key, mine[key]]).toEqual([JSON.stringify(m), key, await checkPermission(CO, USER, 'payroll', action)]);
      }
    }
  });

  it('reads only this company and this user (company scoping)', async () => {
    member({ role: 'viewer' });
    await getMyModulePermissions(CO, USER);
    const [strings, ...values] = sqlMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/cu\.company_id\s*=\s*\?::UUID/);
    expect(strings.join('?')).toMatch(/cu\.user_id\s*=\s*\?/);
    expect(values).toEqual([CO, USER]);
  });

  it('selects every column the rule reads (memberMay): role, approve_withheld, the row and has_row', async () => {
    member({ role: 'viewer' });
    await getMyModulePermissions(CO, USER);
    const [strings] = sqlMock.mock.calls[0] as [TemplateStringsArray];
    const text = strings.join('?');
    const select = text.slice(text.indexOf('SELECT'), text.indexOf('FROM'));
    for (const col of ['pm.module_key', 'cu.role', 'cu.approve_withheld', 'p.can_read', 'p.can_write', 'p.can_delete', 'p.can_export', 'p.can_approve', 'has_row']) {
      expect(select, col).toContain(col);
    }
    expect(text).toMatch(/LEFT JOIN company_user_permissions p\s+ON p\.company_id = cu\.company_id AND p\.user_id = cu\.user_id AND p\.module_key = pm\.module_key/);
  });
});

