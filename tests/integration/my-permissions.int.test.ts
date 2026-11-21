// The nav's GET /api/accounting/my-permissions on the real schema (migrations incl. 1010): getMyModulePermissions' ONE query
// answers exactly what checkPermission (what withPayrollModule enforces) answers, for every module and action, for an
// owner, a manager by default, a manager with approve_withheld, a viewer with a Payroll can_read=false row, a non-member,
// and a user whose only row for the module is in ANOTHER company. Calls the real functions (not a copy of their SQL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getMyModulePermissions } from '@/lib/auth/myPermissions';
import { checkPermission } from '@/lib/auth/permissionService';
import { payrollReadByCompany } from '@/modules/accounting/services/workbench/portfolioPayrollAccess';
import { getPortfolioWorkbench } from '@/modules/accounting/services/workbench/portfolioWorkbenchService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const A = '00000000-0000-0000-0000-0000000d0001';
const B = '00000000-0000-0000-0000-0000000d0002';
const U = {
  owner: '00000000-0000-0000-0000-0000000d00a1', manager: '00000000-0000-0000-0000-0000000d00a2',
  withheld: '00000000-0000-0000-0000-0000000d00a3', viewerNoPayroll: '00000000-0000-0000-0000-0000000d00a4',
  viewer: '00000000-0000-0000-0000-0000000d00a5', stranger: '00000000-0000-0000-0000-0000000d00a6',
  rowElsewhere: '00000000-0000-0000-0000-0000000d00a7',
};
const ACTIONS = ['read', 'write', 'approve'] as const;

describe('getMyModulePermissions (real SQL) agrees with checkPermission', () => {
  let admin: Pool;
  const member = (co: string, user: string, role: string, withheld = false) =>
    admin.query(`INSERT INTO company_users (company_id, user_id, role, approve_withheld) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [co, user, role, withheld]);
  const payrollRow = (co: string, user: string, read: boolean) =>
    admin.query(`INSERT INTO company_user_permissions (company_id, user_id, module_key, can_read, can_write, can_approve)
      VALUES ($1,$2,'payroll',$3,$3,$3) ON CONFLICT (company_id, user_id, module_key) DO UPDATE SET can_read = $3, can_write = $3, can_approve = $3`, [co, user, read]);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(`INSERT INTO permission_modules (module_key, module_name, display_order) VALUES ('payroll','Payroll',130) ON CONFLICT (module_key) DO NOTHING`);
    await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1,'MYP A',true),($2,'MYP B',true) ON CONFLICT (id) DO NOTHING`, [A, B]);
    for (const [k, id] of Object.entries(U)) {
      await admin.query(`INSERT INTO users (id, email, account_type) VALUES ($1,$2,'direct') ON CONFLICT (id) DO NOTHING`, [id, `myp-${k}@fixture.test`]);
    }
    await member(A, U.owner, 'owner');
    await member(A, U.manager, 'manager');
    await member(A, U.withheld, 'manager', true);
    await member(A, U.viewerNoPayroll, 'viewer'); await payrollRow(A, U.viewerNoPayroll, false);
    await member(A, U.viewer, 'viewer');
    // A manager in A with no row there; the only Payroll row they have (read=false) is in B, where they are a viewer.
    await member(A, U.rowElsewhere, 'manager'); await member(B, U.rowElsewhere, 'viewer'); await payrollRow(B, U.rowElsewhere, false);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM company_user_permissions WHERE company_id = ANY($1::UUID[])`, [[A, B]]);
    await admin.query(`DELETE FROM company_users WHERE company_id = ANY($1::UUID[])`, [[A, B]]);
    await admin.query(`DELETE FROM users WHERE id = ANY($1::TEXT[])`, [Object.values(U)]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1::UUID[])`, [[A, B]]);
    await admin.end();
  });

  it('every module and action equals checkPermission, for every kind of member and a non-member', async () => {
    for (const [name, id] of Object.entries(U)) {
      const mine = await getMyModulePermissions(A, id);
      const modules = Object.keys(mine);
      if (name === 'stranger') { expect(modules).toEqual([]); continue; }
      expect(modules).toContain('payroll');
      for (const key of modules) {
        for (const action of ACTIONS) {
          expect([name, key, action, mine[key]![action]]).toEqual([name, key, action, await checkPermission(A, id, key, action)]);
        }
      }
    }
  });

  it('the named cases', async () => {
    const payroll = async (id: string, co = A) => (await getMyModulePermissions(co, id)).payroll;
    expect(await payroll(U.owner)).toEqual({ read: true, write: true, approve: true });
    expect((await payroll(U.manager))!.read).toBe(true);
    expect((await payroll(U.withheld))!.read).toBe(false);
    expect(await payroll(U.viewerNoPayroll)).toEqual({ read: false, write: false, approve: false });
    expect((await payroll(U.viewer))!.read).toBe(true);
    expect(await payroll(U.stranger)).toBeUndefined();
  });

  it("another company's row does not apply here, and this company's does not leak there", async () => {
    expect((await getMyModulePermissions(A, U.rowElsewhere)).payroll!.read).toBe(true);
    expect((await getMyModulePermissions(B, U.rowElsewhere)).payroll!.read).toBe(false);
    expect((await getMyModulePermissions(B, U.viewerNoPayroll)).payroll).toBeUndefined();
  });

  // The portfolio spans every client the user belongs to; Payroll read is decided PER company, in one query.
  it('payrollReadByCompany: one query over two companies equals checkPermission in each, and a non-member is false in both', async () => {
    for (const id of Object.values(U)) {
      const m = await payrollReadByCompany(admin, id, [A, B]);
      for (const co of [A, B]) expect([id, co, m.get(co)]).toEqual([id, co, await checkPermission(co, id, 'payroll', 'read')]);
    }
    const mixed = await payrollReadByCompany(admin, U.rowElsewhere, [A, B]);
    expect([mixed.get(A), mixed.get(B)]).toEqual([true, false]); // one client readable, one not
    const none = await payrollReadByCompany(admin, U.stranger, [A, B]);
    expect([none.get(A), none.get(B)]).toEqual([false, false]);
  });

  it('getPortfolioWorkbench: the client where the user has no Payroll read comes back without the payroll card and says so', async () => {
    const wb = await getPortfolioWorkbench(U.rowElsewhere, '2026-09');
    const rows = Object.fromEntries(wb.rows.map((r) => [r.companyId, r]));
    expect(Object.keys(rows).sort()).toEqual([A, B]);
    expect(rows[B]!.payrollHidden).toBe(true);
    expect(rows[B]!.cards.some((c) => c.id === 'payroll')).toBe(false);
    expect(rows[A]!.payrollHidden).toBeUndefined();
  });
});

