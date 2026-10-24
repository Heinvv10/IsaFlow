// tests/integration/s04-owner-protection.int.test.ts
//
// Audit 2026-10-18 S-04: an admin could demote or remove an owner through
// PUT/DELETE /api/accounting/company-users whenever another owner existed.
// The rule (Hein, 2026-10-21): only an owner may change an owner's role or
// remove an owner; an admin still manages every non-owner.
//
// The service runs here as the route runs it: inside a withAuth-shaped
// transaction (app_user, JWT sub, active company). Since S-07d (migration
// 935) the service writes on the migration_admin pool in its own transaction,
// which re-checks these rules in TypeScript, so the races that held its write
// open inside the request transaction are s07d-member-writes.int.test.ts's,
// on the production migration_admin login.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import {
  updateCompanyUserRole,
  removeCompanyUser,
  OwnerProtectedError,
} from '@/modules/accounting/services/core/userAccessService';

const DATABASE_URL = process.env.DATABASE_URL;
assertDisposableDb('s04 seeds a company and its members.');

const COMPANY = '00000000-0000-4000-8000-0000000a0401';
const OWNER_A = '00000000-0000-4000-8000-0000000a04a1';
const OWNER_B = '00000000-0000-4000-8000-0000000a04b2';
const ADMIN = '00000000-0000-4000-8000-0000000a04c3';
const MANAGER = '00000000-0000-4000-8000-0000000a04d4';
const VIEWER = '00000000-0000-4000-8000-0000000a04e5';
const USERS = [OWNER_A, OWNER_B, ADMIN, MANAGER, VIEWER];

describe.skipIf(!isDisposableDb(DATABASE_URL))('S-04 — only an owner changes or removes an owner', () => {
  let admin: Pool;

  /** Run fn as `actor` inside one withAuth-shaped transaction; commit on success. */
  async function asMember<T>(actor: string, fn: () => Promise<T>, client?: PoolClient): Promise<T> {
    const c = client ?? await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [COMPANY]);
      const out = await als.run({ client: c, userId: actor, companyId: COMPANY, claims: {} } as never, fn);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      if (!client) c.release();
    }
  }

  async function roleOf(userId: string): Promise<string | null> {
    const r = await admin.query(
      'SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [COMPANY, userId]);
    return (r.rows[0]?.role as string | undefined) ?? null;
  }

  async function seedMembers(): Promise<void> {
    await admin.query('DELETE FROM company_users WHERE company_id = $1', [COMPANY]);
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES
         ($1,$2,'owner'), ($1,$3,'owner'), ($1,$4,'admin'), ($1,$5,'manager'), ($1,$6,'viewer')`,
      [COMPANY, OWNER_A, OWNER_B, ADMIN, MANAGER, VIEWER]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'S04 Fixture',true) ON CONFLICT (id) DO NOTHING`,
      [COMPANY]);
    for (const [i, id] of USERS.entries()) {
      await admin.query(
        `INSERT INTO users (id, email, account_type) VALUES ($1,$2,'direct') ON CONFLICT (id) DO NOTHING`,
        [id, `s04-${i}@fixture.test`]);
    }
  });

  beforeEach(seedMembers);

  afterAll(async () => {
    await admin.query('DELETE FROM company_users WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [USERS]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('refuses an admin demoting an owner, and the owner keeps the role', async () => {
    await expect(asMember(ADMIN, () => updateCompanyUserRole(COMPANY, OWNER_B, 'viewer', ADMIN)))
      .rejects.toBeInstanceOf(OwnerProtectedError);
    expect(await roleOf(OWNER_B)).toBe('owner');
  });

  it('refuses an admin removing an owner, and the owner stays a member', async () => {
    await expect(asMember(ADMIN, () => removeCompanyUser(COMPANY, OWNER_B, ADMIN)))
      .rejects.toBeInstanceOf(OwnerProtectedError);
    expect(await roleOf(OWNER_B)).toBe('owner');
  });

  // Breaker REPRO 1: withAuth read the caller's role when the request began; an
  // owner demoted since must not still act on owners as one.
  it('refuses a caller demoted from owner since their request began', async () => {
    await admin.query(`UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2`, [COMPANY, MANAGER]);
    await admin.query(`UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2`, [COMPANY, OWNER_A]);
    await expect(asMember(OWNER_A, () => updateCompanyUserRole(COMPANY, OWNER_B, 'viewer', OWNER_A)))
      .rejects.toBeInstanceOf(OwnerProtectedError);
    await expect(asMember(OWNER_A, () => removeCompanyUser(COMPANY, OWNER_B, OWNER_A)))
      .rejects.toBeInstanceOf(OwnerProtectedError);
    expect(await roleOf(OWNER_B)).toBe('owner');
  });

  it('refuses an admin promoting a member to owner (403 wording, not trigger RC003)', async () => {
    const err = await asMember(ADMIN, () => updateCompanyUserRole(COMPANY, MANAGER, 'owner', ADMIN)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerProtectedError);
    expect((err as Error).message).toBe('Only an owner can grant the owner role.');
    expect(await roleOf(MANAGER)).toBe('manager');
  });

  it('lets an owner demote another owner when two exist', async () => {
    await asMember(OWNER_A, () => updateCompanyUserRole(COMPANY, OWNER_B, 'admin', OWNER_A));
    expect(await roleOf(OWNER_B)).toBe('admin');
  });

  it("recognises the caller as owner whatever the case of their id, as the member guard does", async () => {
    await asMember(OWNER_A, () => updateCompanyUserRole(COMPANY, OWNER_B, 'admin', OWNER_A.toUpperCase()));
    expect(await roleOf(OWNER_B)).toBe('admin');
  });

  it('lets an owner remove another owner when two exist', async () => {
    await asMember(OWNER_A, () => removeCompanyUser(COMPANY, OWNER_B, OWNER_A));
    expect(await roleOf(OWNER_B)).toBeNull();
  });

  it('still lets an admin manage a manager and a viewer', async () => {
    await asMember(ADMIN, () => updateCompanyUserRole(COMPANY, MANAGER, 'viewer', ADMIN));
    expect(await roleOf(MANAGER)).toBe('viewer');
    await asMember(ADMIN, () => removeCompanyUser(COMPANY, VIEWER, ADMIN));
    expect(await roleOf(VIEWER)).toBeNull();
  });

  it('still refuses demoting the last owner, even by that owner', async () => {
    await admin.query(`UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2`, [COMPANY, OWNER_B]);
    await expect(asMember(OWNER_A, () => updateCompanyUserRole(COMPANY, OWNER_A, 'admin', OWNER_A)))
      .rejects.toThrow(/last owner/);
    expect(await roleOf(OWNER_A)).toBe('owner');
  });

  it('two owners demoting each other at the same moment leave exactly one owner', async () => {
    for (let round = 0; round < 10; round++) {
      await seedMembers();
      // Both transactions are open and set up before either demotion starts,
      // so the two service calls overlap rather than run one after the other.
      const [ca, cb] = [await admin.connect(), await admin.connect()];
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const race = (actor: string, target: string, c: PoolClient) =>
          asMember(actor, async () => { await gate; return updateCompanyUserRole(COMPANY, target, 'viewer', actor); }, c);
        const pending = [race(OWNER_A, OWNER_B, ca), race(OWNER_B, OWNER_A, cb)];
        await new Promise((r) => setTimeout(r, 50));
        release();
        const results = await Promise.allSettled(pending);
        const owners = await admin.query(
          `SELECT user_id FROM company_users WHERE company_id = $1 AND role = 'owner'`, [COMPANY]);
        const why = `round ${round}: ${JSON.stringify(results.map(r => r.status === "rejected" ? String(r.reason) : "ok"))} owners=${JSON.stringify(owners.rows)}`;
        expect(owners.rowCount, why).toBe(1);
        expect(results.filter(r => r.status === "fulfilled"), why).toHaveLength(1);
      } finally {
        ca.release(); cb.release();
      }
    }
  });
});
