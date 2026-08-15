// tests/integration/company-users-text-id.int.test.ts
//
// User identity is a STRING throughout this schema, not a uuid:
//   users.id             character varying   (default (gen_random_uuid())::text)
//   company_users.user_id text
//
// Thirteen queries compared company_users.user_id to a ${param}::UUID cast.
// Postgres has no text = uuid operator, so every one of them threw
//   ERROR: operator does not exist: text = uuid
// at runtime — a 500, never a wrong answer. That killed the group-access guards
// (consolidated reports, company groups, intercompany), the permission-grant
// membership guard, POPIA data-subject export, and company user management.
//
// These tests execute the real queries against the real schema. A mocked-sql
// test cannot catch this class of bug at all: the cast is only rejected by
// Postgres, never by TypeScript.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  userBelongsToCompany,
  userBelongsToGroup,
} from '@/modules/accounting/services/core/companyAccessService';
import {
  listCompanyUsers,
  updateCompanyUserRole,
  removeCompanyUser,
} from '@/modules/accounting/services/core/userAccessService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const COMPANY = '00000000-0000-0000-0000-0000000c0001';
const OTHER_COMPANY = '00000000-0000-0000-0000-0000000c0002';
const GROUP = '00000000-0000-0000-0000-0000000c0090';
// user ids are TEXT here — uuid-shaped strings, as GoTrue issues them.
const OWNER = '00000000-0000-0000-0000-0000000c005a';
const MEMBER = '00000000-0000-0000-0000-0000000c005b';
const OUTSIDER = '00000000-0000-0000-0000-0000000c005c';

describe('company_users.user_id is text — queries must not cast the parameter to uuid', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'CU Fixture A',true), ($2,'CU Fixture B',true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY, OTHER_COMPANY]
    );
    await admin.query(
      `INSERT INTO users (id, email, account_type) VALUES
         ($1,'cu-owner@fixture.test','direct'),
         ($2,'cu-member@fixture.test','direct'),
         ($3,'cu-outsider@fixture.test','direct')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER, MEMBER, OUTSIDER]
    );
    // Two owners so the last-owner guard does not block the role/remove tests.
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES
         ($1,$2,'owner'), ($1,$3,'owner')
       ON CONFLICT DO NOTHING`,
      [COMPANY, OWNER, MEMBER]
    );
    // OUTSIDER belongs only to the other company — proves company scoping.
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT DO NOTHING`,
      [OTHER_COMPANY, OUTSIDER]
    );

    await admin.query(
      `INSERT INTO company_groups (id, name, is_active) VALUES ($1,'CU Fixture Group',true)
       ON CONFLICT (id) DO NOTHING`,
      [GROUP]
    );
    await admin.query(
      `INSERT INTO company_group_members (group_id, company_id)
       SELECT $1, $2 WHERE NOT EXISTS (
         SELECT 1 FROM company_group_members WHERE group_id=$1 AND company_id=$2)`,
      [GROUP, COMPANY]
    );
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM company_group_members WHERE group_id=$1`, [GROUP]);
    await admin.query(`DELETE FROM company_groups WHERE id=$1`, [GROUP]);
    await admin.query(`DELETE FROM company_users WHERE company_id = ANY($1::UUID[])`, [[COMPANY, OTHER_COMPANY]]);
    await admin.query(`DELETE FROM users WHERE id = ANY($1::TEXT[])`, [[OWNER, MEMBER, OUTSIDER]]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1::UUID[])`, [[COMPANY, OTHER_COMPANY]]);
    await admin.end();
  });

  describe('userBelongsToCompany', () => {
    it('executes without an operator-does-not-exist error and returns true for a member', async () => {
      await expect(userBelongsToCompany(OWNER, COMPANY)).resolves.toBe(true);
    });

    it('returns false for a user who belongs to a different company', async () => {
      await expect(userBelongsToCompany(OUTSIDER, COMPANY)).resolves.toBe(false);
    });

    it('returns false for an unknown user', async () => {
      await expect(userBelongsToCompany('00000000-0000-0000-0000-0000000000ff', COMPANY)).resolves.toBe(false);
    });
  });

  describe('userBelongsToGroup', () => {
    it('returns true for a user in a member company', async () => {
      await expect(userBelongsToGroup(OWNER, GROUP)).resolves.toBe(true);
    });

    it('returns false for a user with no company in the group', async () => {
      await expect(userBelongsToGroup(OUTSIDER, GROUP)).resolves.toBe(false);
    });

    it('returns false for an unknown group', async () => {
      await expect(userBelongsToGroup(OWNER, '00000000-0000-0000-0000-0000000000fe')).resolves.toBe(false);
    });
  });

  describe('company user management', () => {
    it('lists company users', async () => {
      const rows = await listCompanyUsers(COMPANY);
      expect(rows.map(r => r.userId).sort()).toEqual([OWNER, MEMBER].sort());
    });

    it('updates a role without an operator-does-not-exist error', async () => {
      await updateCompanyUserRole(COMPANY, MEMBER, 'manager');
      const rows = await listCompanyUsers(COMPANY);
      expect(rows.find(r => r.userId === MEMBER)?.role).toBe('manager');
      // restore so the remove test still has two owners to work with
      await updateCompanyUserRole(COMPANY, MEMBER, 'owner');
    });

    it('removes a company user without an operator-does-not-exist error', async () => {
      await removeCompanyUser(COMPANY, MEMBER);
      const rows = await listCompanyUsers(COMPANY);
      expect(rows.map(r => r.userId)).toEqual([OWNER]);
      // put it back for afterAll symmetry
      await admin.query(
        `INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
        [COMPANY, MEMBER]
      );
    });
  });
});
