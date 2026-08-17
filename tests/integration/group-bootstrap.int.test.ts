// tests/integration/group-bootstrap.int.test.ts
//
// A company group created WITHOUT a holding company had no members, and:
//   1. the group list INNER JOINed company_group_members, so it vanished; and
//   2. add-member gated on verifyGroupAccess, which requires an existing member.
// Together those made a new group permanently orphaned — invisible in the UI and
// unreachable by every guarded action. The only escape was direct DB access,
// which is how "Incendio Global" had to be populated in production.
//
// (createGroup DOES auto-enrol a holding company as the first member, so the
// orphan only occurs when that optional field is left empty — which is exactly
// what happened, because the Holding Company picker rendered blank options.)
//
// These tests exercise the real service functions against the real schema.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  userBelongsToGroup,
  userCreatedGroup,
  userBelongsToCompany,
} from '@/modules/accounting/services/core/companyAccessService';
import { listGroupsForUser } from '@/modules/accounting/services/reports/groupCrudService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const COMPANY = '00000000-0000-0000-0000-0000000b0001';
const FOREIGN_COMPANY = '00000000-0000-0000-0000-0000000b0002';
const ORPHAN_GROUP = '00000000-0000-0000-0000-0000000b0090';
const OTHERS_GROUP = '00000000-0000-0000-0000-0000000b0091';
const CREATOR = '00000000-0000-0000-0000-0000000b005a';
const STRANGER = '00000000-0000-0000-0000-0000000b005b';

describe('group bootstrap: a memberless group must remain reachable by its creator', () => {
  let admin: Pool;
  // Calls the REAL production function, not a copy of its SQL — a duplicated
  // query string here would keep passing after the route's query changed.
  const listFor = async (userId: string) =>
    (await listGroupsForUser(userId)).map(g => ({ id: g.id, member_count: g.memberCount }));

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'GB Fixture',true), ($2,'GB Foreign',true)
       ON CONFLICT (id) DO NOTHING`, [COMPANY, FOREIGN_COMPANY]);
    await admin.query(
      `INSERT INTO users (id, email, account_type) VALUES ($1,'gb-creator@fixture.test','direct'), ($2,'gb-stranger@fixture.test','direct')
       ON CONFLICT (id) DO NOTHING`, [CREATOR, STRANGER]);
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT DO NOTHING`, [COMPANY, CREATOR]);
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT DO NOTHING`, [FOREIGN_COMPANY, STRANGER]);

    // The orphan: created by CREATOR, deliberately zero members.
    await admin.query(
      `INSERT INTO company_groups (id, name, is_active, created_by) VALUES ($1,'GB Orphan',true,$2::UUID)
       ON CONFLICT (id) DO NOTHING`, [ORPHAN_GROUP, CREATOR]);
    // Someone else's group, also memberless — CREATOR must never see it.
    await admin.query(
      `INSERT INTO company_groups (id, name, is_active, created_by) VALUES ($1,'GB Someone Else',true,$2::UUID)
       ON CONFLICT (id) DO NOTHING`, [OTHERS_GROUP, STRANGER]);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM company_group_members WHERE group_id = ANY($1::UUID[])`, [[ORPHAN_GROUP, OTHERS_GROUP]]);
    await admin.query(`DELETE FROM company_groups WHERE id = ANY($1::UUID[])`, [[ORPHAN_GROUP, OTHERS_GROUP]]);
    await admin.query(`DELETE FROM company_users WHERE company_id = ANY($1::UUID[])`, [[COMPANY, FOREIGN_COMPANY]]);
    await admin.query(`DELETE FROM users WHERE id = ANY($1::TEXT[])`, [[CREATOR, STRANGER]]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1::UUID[])`, [[COMPANY, FOREIGN_COMPANY]]);
    await admin.end();
  });

  describe('visibility', () => {
    it('lists a memberless group to its creator, with member_count 0', async () => {
      const rows = await listFor(CREATOR);
      const orphan = rows.find(r => r.id === ORPHAN_GROUP);
      expect(orphan).toBeDefined();
      expect(orphan?.member_count).toBe(0);
    });

    it('does NOT leak another user\'s memberless group', async () => {
      const rows = await listFor(CREATOR);
      expect(rows.map(r => r.id)).not.toContain(OTHERS_GROUP);
    });

    it('does not show the orphan to a stranger', async () => {
      const rows = await listFor(STRANGER);
      expect(rows.map(r => r.id)).not.toContain(ORPHAN_GROUP);
    });
  });

  describe('bootstrap authorisation', () => {
    it('the creator is not a group member yet — so membership alone cannot authorise', async () => {
      await expect(userBelongsToGroup(CREATOR, ORPHAN_GROUP)).resolves.toBe(false);
    });

    it('but userCreatedGroup authorises them to add the first member', async () => {
      await expect(userCreatedGroup(CREATOR, ORPHAN_GROUP)).resolves.toBe(true);
    });

    it('and they still may only add a company they belong to', async () => {
      await expect(userBelongsToCompany(CREATOR, COMPANY)).resolves.toBe(true);
      await expect(userBelongsToCompany(CREATOR, FOREIGN_COMPANY)).resolves.toBe(false);
    });

    it('a stranger cannot bootstrap someone else\'s group', async () => {
      await expect(userCreatedGroup(STRANGER, ORPHAN_GROUP)).resolves.toBe(false);
      await expect(userBelongsToGroup(STRANGER, ORPHAN_GROUP)).resolves.toBe(false);
    });

    it('creating a group does not by itself grant group READ access', async () => {
      // userBelongsToGroup gates the consolidated financial reads and must stay
      // strictly membership-based — userCreatedGroup is only for add-member.
      await expect(userBelongsToGroup(CREATOR, ORPHAN_GROUP)).resolves.toBe(false);
    });
  });

  describe('once bootstrapped', () => {
    it('membership takes over and member_count reflects the real members', async () => {
      await admin.query(
        `INSERT INTO company_group_members (group_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [ORPHAN_GROUP, COMPANY]);
      try {
        await expect(userBelongsToGroup(CREATOR, ORPHAN_GROUP)).resolves.toBe(true);
        const orphan = (await listFor(CREATOR)).find(r => r.id === ORPHAN_GROUP);
        expect(orphan?.member_count).toBe(1);
      } finally {
        await admin.query(`DELETE FROM company_group_members WHERE group_id = $1`, [ORPHAN_GROUP]);
      }
    });
  });
});
