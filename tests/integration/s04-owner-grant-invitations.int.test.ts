// tests/integration/s04-owner-grant-invitations.int.test.ts
//
// S-04 follow-on (blind review finding 3): createInvitation grants owner too —
// an owner invitation, or (when it can see the user) a company_users INSERT at
// the invited role. Like updateCompanyUserRole's promotion it takes the owner
// lock and reads the inviter's role live after it.
//
// As app_user (withAuth's shape) the invitation trigger (migs 883/886) is live
// too, but it reads the inviter's role from its snapshot, without the lock:
// the race below is refused only by the service. Outside app_user (any role
// other than app_user / platform_admin) the trigger returns at once, and the
// service is the only check: the last two cases run there. Under app_user,
// users_self_read hides every other user's row, so the auto-add path is
// reachable only outside it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { updateCompanyUserRole, createInvitation, OwnerProtectedError } from '@/modules/accounting/services/core/userAccessService';

const DATABASE_URL = process.env.DATABASE_URL;
assertDisposableDb('s04 invitations seeds a company, its members and invitations.');

const COMPANY = '00000000-0000-4000-8000-0000000a0402';
const OWNER_A = '00000000-0000-4000-8000-0000000a14a1';
const OWNER_B = '00000000-0000-4000-8000-0000000a14b2';
const ADMIN = '00000000-0000-4000-8000-0000000a14c3';
const EXISTING = '00000000-0000-4000-8000-0000000a14d4';
const USERS = [OWNER_A, OWNER_B, ADMIN, EXISTING];
const INVITEE = 's04-invitee@fixture.test';
const EXISTING_EMAIL = 's04i-3@fixture.test';

describe.skipIf(!isDisposableDb(DATABASE_URL))('S-04 — only a live owner grants owner by invitation', () => {
  let admin: Pool;

  /** Run fn in one transaction, as `actor` under app_user (withAuth's shape) unless `asApp` is false. */
  async function asMember<T>(actor: string, fn: () => Promise<T>, client?: PoolClient, asApp = true): Promise<T> {
    const c = client ?? await admin.connect();
    try {
      await c.query('BEGIN');
      if (asApp) {
        await c.query('SET LOCAL ROLE app_user');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor })]);
        await c.query("SELECT set_config('app.current_company_id', $1, true)", [COMPANY]);
      }
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

  async function invitationRole(): Promise<string | null> {
    const r = await admin.query('SELECT role FROM company_invitations WHERE company_id = $1 AND email = $2', [COMPANY, INVITEE]);
    return (r.rows[0]?.role as string | undefined) ?? null;
  }

  async function roleOf(userId: string): Promise<string | null> {
    const r = await admin.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [COMPANY, userId]);
    return (r.rows[0]?.role as string | undefined) ?? null;
  }

  async function seed(): Promise<void> {
    await admin.query('DELETE FROM company_invitations WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM company_users WHERE company_id = $1', [COMPANY]);
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner'), ($1,$3,'owner'), ($1,$4,'admin')`,
      [COMPANY, OWNER_A, OWNER_B, ADMIN]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'S04 Invitations Fixture',true) ON CONFLICT (id) DO NOTHING`,
      [COMPANY]);
    for (const [i, id] of USERS.entries()) {
      await admin.query(
        `INSERT INTO users (id, email, account_type) VALUES ($1,$2,'direct') ON CONFLICT (id) DO NOTHING`,
        [id, `s04i-${i}@fixture.test`]);
    }
  });

  beforeEach(seed);

  afterAll(async () => {
    await admin.query('DELETE FROM company_invitations WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM company_users WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [USERS]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('refuses an admin inviting someone as owner, and writes no invitation', async () => {
    const err = await asMember(ADMIN, () => createInvitation(COMPANY, INVITEE, 'owner', ADMIN)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerProtectedError);
    expect((err as Error).message).toBe('Only an owner can grant the owner role.');
    expect(await invitationRole()).toBeNull();
  });

  it('lets an owner invite someone as owner', async () => {
    await asMember(OWNER_A, () => createInvitation(COMPANY, INVITEE, 'owner', OWNER_A));
    expect(await invitationRole()).toBe('owner');
  });

  it('an owner being demoted at that moment cannot send an owner invitation', async () => {
    for (let round = 0; round < 5; round++) {
      await seed();
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
        const aInvites = asMember(OWNER_A, () => createInvitation(COMPANY, INVITEE, 'owner', OWNER_A), ca);
        // Released whatever happens: an A that never waits must not leave B's
        // transaction open, holding the lock, for the tests after this one.
        try { await aWaits(); } finally { commitDemotion(); }
        const [b, a] = await Promise.allSettled([demoteA, aInvites]);
        expect(b.status, `round ${round}`).toBe('fulfilled');
        expect(a.status === 'rejected' ? a.reason : a.status, `round ${round}`).toBeInstanceOf(OwnerProtectedError);
        expect(await invitationRole(), `round ${round}`).toBeNull();
      } finally {
        cb.release(); ca.release();
      }
    }
  });

  it('outside app_user (no trigger), refuses an admin auto-adding an existing user as owner', async () => {
    await expect(asMember(ADMIN, () => createInvitation(COMPANY, EXISTING_EMAIL, 'owner', ADMIN), undefined, false))
      .rejects.toBeInstanceOf(OwnerProtectedError);
    expect(await roleOf(EXISTING)).toBeNull();
  });

  it('outside app_user, lets an owner auto-add an existing user as owner', async () => {
    await expect(asMember(OWNER_A, () => createInvitation(COMPANY, EXISTING_EMAIL, 'owner', OWNER_A), undefined, false))
      .resolves.toMatchObject({ autoAdded: true });
    expect(await roleOf(EXISTING)).toBe('owner');
  });
});
