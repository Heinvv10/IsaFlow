// tests/integration/s04-owner-protection.int.test.ts
//
// Audit 2026-10-18 S-04: an admin could demote or remove an owner through
// PUT/DELETE /api/accounting/company-users whenever another owner existed.
// The rule (Hein, 2026-10-21): only an owner may change an owner's role or
// remove an owner; an admin still manages every non-owner.
//
// The service runs here as the route runs it: inside a withAuth-shaped
// transaction (app_user, JWT sub, active company), so the member role guard
// trigger (migs 883/886) is live too. The race test drives two such
// transactions at once and checks the outcome, not who refused.

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

  /** A function that resolves once `client`'s backend is waiting on a lock (row or advisory). */
  async function lockWaiter(client: PoolClient): Promise<() => Promise<void>> {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    return async () => {
      for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
        const r = await admin.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
        if (r.rows[0]?.wait_event_type === 'Lock') return;
        await new Promise((res) => setTimeout(res, 10));
      }
      throw new Error(`backend ${pid} never waited on a lock`);
    };
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

  // Breaker round 2 NEW B: the caller's role is read AFTER the owner lock. B,
  // demoting A, holds that lock; A's own owner action must wait for it and
  // then see that A is no longer an owner.
  it('a caller being demoted at that moment never acts on an owner as one', async () => {
    for (let round = 0; round < 5; round++) {
      await seedMembers();
      await admin.query(`UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2`, [COMPANY, MANAGER]);
      const [cb, ca] = [await admin.connect(), await admin.connect()];
      try {
        const aWaits = await lockWaiter(ca);
        let commitDemotion!: () => void;
        let bHoldsLock!: () => void;
        const held = new Promise<void>((r) => { commitDemotion = r; });
        const locked = new Promise<void>((r) => { bHoldsLock = r; });
        const demoteA = asMember(OWNER_B, async () => {
          await updateCompanyUserRole(COMPANY, OWNER_A, 'viewer', OWNER_B);
          bHoldsLock();
          await held; // B holds the owner lock, A's demotion uncommitted
        }, cb);
        await Promise.race([locked, demoteA]); // a throwing holder fails here, not at the timeout
        const aActs = asMember(OWNER_A, () => updateCompanyUserRole(COMPANY, MANAGER, 'viewer', OWNER_A), ca);
        await aWaits();
        commitDemotion();
        const [b, a] = await Promise.allSettled([demoteA, aActs]);
        expect(b.status, `round ${round}`).toBe('fulfilled');
        expect(a.status === 'rejected' ? a.reason : a.status, `round ${round}`).toBeInstanceOf(OwnerProtectedError);
        expect(await roleOf(MANAGER), `round ${round}`).toBe('owner');
      } finally {
        cb.release(); ca.release();
      }
    }
  });

  it('refuses an admin promoting a member to owner (403 wording, not trigger RC003)', async () => {
    const err = await asMember(ADMIN, () => updateCompanyUserRole(COMPANY, MANAGER, 'owner', ADMIN)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerProtectedError);
    expect((err as Error).message).toBe('Only an owner can grant the owner role.');
    expect(await roleOf(MANAGER)).toBe('manager');
  });

  // The trigger reads the actor's role from its statement snapshot, without the
  // owner lock: it still sees A as an owner while B's demotion of A is
  // uncommitted. Only the service's live read after the lock refuses A.
  it('an owner being demoted at that moment cannot promote anyone to owner', async () => {
    for (let round = 0; round < 5; round++) {
      await seedMembers();
      const [cb, ca] = [await admin.connect(), await admin.connect()];
      try {
        const aWaits = await lockWaiter(ca);
        let commitDemotion!: () => void;
        let bHoldsLock!: () => void;
        const held = new Promise<void>((r) => { commitDemotion = r; });
        const locked = new Promise<void>((r) => { bHoldsLock = r; });
        const demoteA = asMember(OWNER_B, async () => {
          await updateCompanyUserRole(COMPANY, OWNER_A, 'viewer', OWNER_B);
          bHoldsLock();
          await held;
        }, cb);
        await Promise.race([locked, demoteA]);
        const aPromotes = asMember(OWNER_A, () => updateCompanyUserRole(COMPANY, MANAGER, 'owner', OWNER_A), ca);
        await aWaits();
        commitDemotion();
        const [b, a] = await Promise.allSettled([demoteA, aPromotes]);
        expect(b.status, `round ${round}`).toBe('fulfilled');
        expect(a.status === 'rejected' ? a.reason : a.status, `round ${round}`).toBeInstanceOf(OwnerProtectedError);
        expect(await roleOf(MANAGER), `round ${round}`).toBe('manager');
      } finally {
        cb.release(); ca.release();
      }
    }
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

  // The target's role is read FOR UPDATE: without it, an admin reads X as a
  // manager while an owner's promotion of X is in flight, and then demotes the
  // new owner once that commits.
  it('an admin demoting a member an owner is promoting at that moment never demotes an owner', async () => {
    for (let round = 0; round < 5; round++) {
      await seedMembers();
      const [co, ca] = [await admin.connect(), await admin.connect()];
      try {
        const adminWaits = await lockWaiter(ca);
        let commitPromotion!: () => void;
        let promoted!: () => void;
        const held = new Promise<void>((r) => { commitPromotion = r; });
        const written = new Promise<void>((r) => { promoted = r; });
        const promotion = asMember(OWNER_A, async () => {
          await updateCompanyUserRole(COMPANY, MANAGER, 'owner', OWNER_A);
          promoted();
          await held; // keep the promotion uncommitted while the admin starts
        }, co);
        await Promise.race([written, promotion]); // a throwing holder fails here, not at the timeout
        const demotion = asMember(ADMIN, () => updateCompanyUserRole(COMPANY, MANAGER, 'viewer', ADMIN), ca);
        await adminWaits();
        commitPromotion();
        const [p, d] = await Promise.allSettled([promotion, demotion]);
        expect(p.status, `round ${round}`).toBe('fulfilled');
        expect(d.status === 'rejected' ? d.reason : d.status, `round ${round}`).toBeInstanceOf(OwnerProtectedError);
        expect(await roleOf(MANAGER), `round ${round}`).toBe('owner');
      } finally {
        co.release(); ca.release();
      }
    }
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
