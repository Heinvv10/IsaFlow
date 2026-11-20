// #1656 round 4: checkGroupPermission's ONE query on the real schema: a write role AND the permission in the SAME current member
// company of the group; a company that left the group, a viewer's stale approve row, a withheld manager and a write role in
// another company are all refused. Calls the real function (not a copy of its SQL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { checkGroupPermission } from '@/lib/auth/permissionService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const A = '00000000-0000-0000-0000-0000000c0001';
const B = '00000000-0000-0000-0000-0000000c0002';
const LEFT = '00000000-0000-0000-0000-0000000c0003';
const GROUP = '00000000-0000-0000-0000-0000000c0090';
const U = {
  writer: '00000000-0000-0000-0000-0000000c00a1', viewerStale: '00000000-0000-0000-0000-0000000c00a2',
  split: '00000000-0000-0000-0000-0000000c00a3', withheld: '00000000-0000-0000-0000-0000000c00a4',
  bookkeeper: '00000000-0000-0000-0000-0000000c00a5', leftCo: '00000000-0000-0000-0000-0000000c00a6',
  none: '00000000-0000-0000-0000-0000000c00a7', viewer: '00000000-0000-0000-0000-0000000c00a8',
};

describe('checkGroupPermission (real SQL)', () => {
  let admin: Pool;
  const member = (co: string, user: string, role: string, withheld = false) =>
    admin.query(`INSERT INTO company_users (company_id, user_id, role, approve_withheld) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [co, user, role, withheld]);
  const row = (co: string, user: string, approve: boolean) =>
    admin.query(`INSERT INTO company_user_permissions (company_id, user_id, module_key, can_read, can_write, can_approve)
      VALUES ($1,$2,'group',true,true,$3) ON CONFLICT (company_id, user_id, module_key) DO UPDATE SET can_approve = $3`, [co, user, approve]);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(`INSERT INTO permission_modules (module_key, module_name, display_order) VALUES ('group','Group Consolidation',150) ON CONFLICT (module_key) DO NOTHING`);
    await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1,'CGP A',true),($2,'CGP B',true),($3,'CGP Left',true) ON CONFLICT (id) DO NOTHING`, [A, B, LEFT]);
    for (const [k, id] of Object.entries(U)) {
      await admin.query(`INSERT INTO users (id, email, account_type) VALUES ($1,$2,'direct') ON CONFLICT (id) DO NOTHING`, [id, `cgp-${k}@fixture.test`]);
    }
    await admin.query(`INSERT INTO company_groups (id, name, is_active) VALUES ($1,'CGP Group',true) ON CONFLICT (id) DO NOTHING`, [GROUP]);
    await admin.query(`INSERT INTO company_group_members (group_id, company_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [GROUP, A, B]);
    await admin.query(`INSERT INTO company_group_members (group_id, company_id, left_date) VALUES ($1,$2,CURRENT_DATE - 1) ON CONFLICT DO NOTHING`, [GROUP, LEFT]);
    await member(A, U.writer, 'manager');
    await member(A, U.viewerStale, 'viewer'); await row(A, U.viewerStale, true);
    await member(A, U.split, 'viewer'); await row(A, U.split, true); // approve in A, but no write role there
    await member(B, U.split, 'manager'); await row(B, U.split, false); // write role in B, but no approve there
    await member(A, U.withheld, 'manager', true);
    await member(A, U.bookkeeper, 'bookkeeper', true);
    await member(LEFT, U.leftCo, 'owner');
    await member(A, U.viewer, 'viewer');
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM company_user_permissions WHERE company_id = ANY($1::UUID[])`, [[A, B, LEFT]]);
    await admin.query(`DELETE FROM company_users WHERE company_id = ANY($1::UUID[])`, [[A, B, LEFT]]);
    await admin.query(`DELETE FROM company_group_members WHERE group_id = $1::UUID`, [GROUP]);
    await admin.query(`DELETE FROM company_groups WHERE id = $1::UUID`, [GROUP]);
    await admin.query(`DELETE FROM users WHERE id = ANY($1::TEXT[])`, [Object.values(U)]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1::UUID[])`, [[A, B, LEFT]]);
    await admin.end();
  });

  it('a manager with the default approves; one with the flag, a viewer with a stale row, and a user in no member company do not', async () => {
    expect(await checkGroupPermission(U.writer, GROUP, 'group', 'approve')).toBe(true);
    expect(await checkGroupPermission(U.withheld, GROUP, 'group', 'approve')).toBe(false);
    expect(await checkGroupPermission(U.viewerStale, GROUP, 'group', 'approve')).toBe(false);
    expect(await checkGroupPermission(U.none, GROUP, 'group', 'approve')).toBe(false);
  });

  it('the write role and the Approve must be in the SAME company (approve in A as a viewer, write in B without it)', async () => {
    expect(await checkGroupPermission(U.split, GROUP, 'group', 'approve')).toBe(false);
  });

  it('a company that left the group no longer carries the user', async () => {
    expect(await checkGroupPermission(U.leftCo, GROUP, 'group', 'approve')).toBe(false);
  });

  it('a stored bookkeeper is a write role; an owner\'s explicit row grants it, the flag withholds the default', async () => {
    expect(await checkGroupPermission(U.bookkeeper, GROUP, 'group', 'approve')).toBe(false);
    await row(A, U.bookkeeper, true);
    expect(await checkGroupPermission(U.bookkeeper, GROUP, 'group', 'approve')).toBe(true);
  });

  it('a read needs no write role (round 4): a viewer reads the group, but never writes or approves it', async () => {
    expect(await checkGroupPermission(U.viewer, GROUP, 'group', 'read')).toBe(true);
    expect(await checkGroupPermission(U.viewer, GROUP, 'group', 'write')).toBe(false);
    expect(await checkGroupPermission(U.viewer, GROUP, 'group', 'approve')).toBe(false);
  });
});
