/**
 * R-035 N1b (C), migration 886 — adversarial review of PR #691, round 5:
 *
 *  - isolation: 883's last-owner lock serialises the writers, but only a READ
 *    COMMITTED statement re-reads after the wait; a REPEATABLE READ or
 *    SERIALIZABLE writer judges every rule from its old snapshot, so two of
 *    them each demoting one of two owners left none, an owner demoted after
 *    the snapshot still granted owner, and an admin removed after it still
 *    promoted an accomplice and sent invitations (SSI does not see a READ
 *    COMMITTED writer; adversarial #693 REPRO 1). At any level but READ
 *    COMMITTED (and READ UNCOMMITTED, which Postgres runs as it) every
 *    app_user write is refused (40001) — after the rule checks, so a write a
 *    rule refuses keeps its code (#693 REPRO 2); the admin portal is not,
 *    except when it removes or demotes an owner (909, its last-owner rule);
 *  - owner-ness is company_member_role_is_owner: lower-cased, all whitespace
 *    (ASCII and Unicode) removed. A legacy owner-ish invitation is an owner's
 *    to re-open, and an owner-ish membership is an owner's for the last-owner
 *    rule (886's precondition refuses to apply while either exists; these
 *    rows are written here as the table owner).
 *
 * The portal-vs-app races are r035-n1b-members-takeover's, unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRole, outcome } from './r035-n1.helpers';
import { cleanupMembers, company, emailOf, people, roleOf, tokenHash, type People } from './r035-n1b-members.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
let p: People;

beforeAll(async () => { p = await people(pool, users); });
afterAll(() => cleanupMembers(pool, companies, users));

const asApp = (c: string, sub: string, fn: (cl: PoolClient) => Promise<unknown>) => asRole(pool, 'app_user', c, { sub }, fn, true);
const owners = async (c: string) => Number((await pool.query(
  "SELECT count(*) FROM company_users WHERE company_id = $1 AND role = 'owner'", [c])).rows[0].count);
const DEMOTE = "UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2";
const INVITE = `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
                VALUES($1,$2,$3,$4,$5, now() + interval '7 days')`;

/** app_user under `sub`'s claims at `level`; the snapshot is taken by the first query. */
async function session(c: string, sub: string, level: string): Promise<PoolClient> {
  const cl = await pool.connect();
  await cl.query(`BEGIN ISOLATION LEVEL ${level}`);
  await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, session_id: crypto.randomUUID() })]);
  await cl.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
  await cl.query('SET LOCAL ROLE app_user');
  return cl;
}
/** Runs `statement`; commits what got through, rolls back what did not. Never leaves a session open. */
async function finish(cl: PoolClient, statement: string, params: unknown[]): Promise<string> {
  try {
    const result = await outcome(cl.query(statement, params));
    await cl.query(result === 'ok' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } finally { cl.release(); }
}

const GRANT = "UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2";
const REMOVE = 'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2';
const RESHAPE = "UPDATE company_invitations SET expires_at = now() + interval '30 days' WHERE company_id = $1";
const inviteAs = (c: string, by: string, role: string) => [c, emailOf(p.x), role, by, tokenHash(crypto.randomUUID())];

/** Waits until backend `pid` waits on a lock. */
async function blocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])).rows.length) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`backend ${pid} never blocked`);
}

describe.each(['REPEATABLE READ', 'SERIALIZABLE'])('%s: refused (40001) — the snapshot is not re-read after the lock', (level) => {
  // The actors are owners: since 909 an admin demoting an owner is RC010, a rule code, ahead of 40001.
  it('two sessions each demoting one of two owners: both refused, the owners stay', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'owner'], [p.a, 'admin']]);
    const one = await session(c, p.o, level);
    const two = await session(c, p.o2, level); // its snapshot predates the first's commit
    const first = await finish(one, DEMOTE, [c, p.o2]);
    const second = await finish(two, DEMOTE, [c, p.o]);
    expect([first, second, await owners(c)]).toEqual(['40001', '40001', 2]);
  });

  it('an app (READ COMMITTED) demotion commits; the other owner\'s, from an older snapshot, is refused', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'owner'], [p.a, 'admin']]);
    const stale = await session(c, p.o2, level); // o2 is an owner in this snapshot
    expect(await outcome(asApp(c, p.o, (cl) => cl.query(DEMOTE, [c, p.o2])))).toBe('ok');
    expect(await finish(stale, DEMOTE, [c, p.o])).toBe('40001');
    expect(await owners(c)).toBe(1);
  });

  it('the removal of an owner too', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.o, level), REMOVE, [c, p.o2])).toBe('40001');
    expect(await owners(c)).toBe(2);
  });

  it('an owner demoted after the snapshot cannot grant owner from it', async () => {
    const c = await company(pool, p, companies);
    const stale = await session(c, p.o, level); // o is an owner in this snapshot
    expect(await outcome(asApp(c, p.o2, (cl) => cl.query(DEMOTE, [c, p.o])))).toBe('ok');
    expect(await finish(stale, GRANT, [c, p.m])).toBe('40001');
    expect([await roleOf(pool, c, p.o), await roleOf(pool, c, p.m)]).toEqual(['admin', 'manager']);
  });

  it('an owner invitation is neither written nor re-shaped', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.o, level), INVITE, inviteAs(c, p.o, 'owner'))).toBe('40001');
    await asApp(c, p.o, (cl) => cl.query(INVITE, inviteAs(c, p.o, 'owner')));
    expect(await finish(await session(c, p.o, level), RESHAPE, [c])).toBe('40001');
  });

  it('every app_user write is refused, even one that touches no owner', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.a, level), "UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [c, p.m])).toBe('40001');
    expect(await finish(await session(c, p.a, level), INVITE, inviteAs(c, p.a, 'manager'))).toBe('40001');
    await asApp(c, p.a, (cl) => cl.query(INVITE, inviteAs(c, p.a, 'manager')));
    expect(await finish(await session(c, p.a, level), 'DELETE FROM company_invitations WHERE company_id = $1', [c])).toBe('40001');
    expect(await roleOf(pool, c, p.m)).toBe('manager');
  });

  it('an admin removed after the snapshot can neither promote nor invite (adversarial #693 REPRO 1)', async () => {
    const c = await company(pool, p, companies);
    const promote = await session(c, p.a, level);
    const invite = await session(c, p.a, level);
    expect(await outcome(asApp(c, p.o, (cl) => cl.query(REMOVE, [c, p.a])))).toBe('ok');
    expect(await finish(promote, "UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", [c, p.m])).toBe('40001');
    expect(await finish(invite, INVITE, [c, emailOf(p.a), 'admin', p.a, tokenHash(crypto.randomUUID())])).toBe('40001');
    expect([await roleOf(pool, c, p.a), await roleOf(pool, c, p.m)]).toEqual([null, 'manager']);
    expect((await pool.query('SELECT count(*)::INT AS n FROM company_invitations WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });

  it('a write a rule refuses keeps the rule\'s code: an admin granting owner is RC003 (adversarial #693 REPRO 2)', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.a, level), GRANT, [c, p.m])).toBe('RC003');
    expect(await finish(await session(c, p.a, level), INVITE, inviteAs(c, p.a, 'owner'))).toBe('RC003');
  });

  it('a no-op write to a legacy owner-ish membership is refused too', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'Owner '], [p.a, 'admin']]);
    expect(await finish(await session(c, p.a, level), 'UPDATE company_users SET role = role WHERE company_id = $1 AND user_id = $2', [c, p.o2])).toBe('40001');
  });

  // Since 909 the portal judges one thing, the last owner (RC011), so removing
  // or demoting an owner is refused outside READ COMMITTED too; nothing else is.
  it('the admin portal (platform_admin) is refused only for an owner it removes or demotes', async () => {
    const c = await company(pool, p, companies);
    const portal = async (statement: string, params: unknown[]) => {
      const cl = await pool.connect();
      await cl.query(`BEGIN ISOLATION LEVEL ${level}`);
      await cl.query('SET LOCAL ROLE platform_admin');
      return finish(cl, statement, params);
    };
    expect(await portal("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'accountant')", [c, p.x])).toBe('ok');
    expect(await portal("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [c, p.m])).toBe('ok');
    expect(await portal(DEMOTE, [c, p.o2])).toBe('40001');
    expect(await portal(REMOVE, [c, p.o2])).toBe('40001');
    expect([await roleOf(pool, c, p.x), await roleOf(pool, c, p.m), await roleOf(pool, c, p.o2)]).toEqual(['accountant', 'viewer', 'owner']);
  });
});

describe.each(['READ COMMITTED', 'READ UNCOMMITTED'])('%s: judged after the lock, not refused', (level) => {
  // Owners as actors (an admin is RC010 since 909); the second's actor is the
  // owner the first demotes, so after the wait it is no longer an owner (RC010).
  it('two sessions each demoting one of two owners: the second waits, then is refused (RC010)', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'owner'], [p.a, 'admin']]);
    const one = await session(c, p.o, level);
    const two = await session(c, p.o2, level);
    try {
      await one.query(DEMOTE, [c, p.o2]);
      const pid = (await two.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const second = outcome(two.query(DEMOTE, [c, p.o]));
      await blocked(pid);
      await one.query('COMMIT');
      expect(await second).toBe('RC010');
    } finally {
      await two.query('ROLLBACK').catch(() => undefined);
      await one.query('ROLLBACK').catch(() => undefined);
      one.release();
      two.release();
    }
    expect(await owners(c)).toBe(1);
  });

  it('an owner grants owner, writes and re-shapes an owner invitation, and removes a non-last owner', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.o, level), GRANT, [c, p.m])).toBe('ok');
    expect(await finish(await session(c, p.o, level), INVITE, inviteAs(c, p.o, 'owner'))).toBe('ok');
    expect(await finish(await session(c, p.o, level), RESHAPE, [c])).toBe('ok');
    expect(await finish(await session(c, p.o, level), REMOVE, [c, p.o2])).toBe('ok');
    expect([await roleOf(pool, c, p.m), await roleOf(pool, c, p.o2)]).toEqual(['owner', null]);
  });
});

// Trailing/leading/inner ASCII whitespace, case, and Unicode spaces (U+00A0, U+2007, U+200B, U+2060, U+0085 and U+180E:
// `\s` misses them under en_US.utf8, and each is a member of the predicate's class a mutant could drop).
const OWNERISH = ['Owner ', 'owner\t', ' Owner', 'OWNER', '\u00a0owner', 'own\u2007er',
  'own\u200ber', 'owner\u2060', '\u0085owner', 'ow\u180ener'];

describe.each(OWNERISH)('a legacy owner-ish role %j is an owner\'s', (legacy) => {
  /** An expired owner invitation stored before the allow-list. */
  async function legacyInvitation(c: string) {
    await pool.query(`INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
      VALUES($1,$2,$3,$4,$5, now() - interval '1 day')`, [c, emailOf(p.x), legacy, p.o, tokenHash(crypto.randomUUID())]);
  }
  const REOPEN = "UPDATE company_invitations SET expires_at = now() + interval '7 days' WHERE company_id = $1";

  it('an admin cannot re-open the invitation (RC003); it stays expired', async () => {
    const c = await company(pool, p, companies);
    await legacyInvitation(c);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(REOPEN, [c])))).toBe('RC003');
    expect((await pool.query('SELECT expires_at < now() AS expired FROM company_invitations WHERE company_id = $1', [c])).rows)
      .toEqual([{ expired: true }]);
  });

  it('an owner can', async () => {
    const c = await company(pool, p, companies);
    await legacyInvitation(c);
    expect(await outcome(asApp(c, p.o, (cl) => cl.query(REOPEN, [c])))).toBe('ok');
  });

  // It is an owner's row for 909's rules too: an admin is refused (RC010), and
  // so is the admin portal (RC011, the exact-'owner' count finds no other).
  it('the only owner-ish membership is not demoted (RC010 as an admin, RC011 as the portal)', async () => {
    const c = await company(pool, p, companies, [[p.o, legacy], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(DEMOTE, [c, p.o])))).toBe('RC010');
    expect(await outcome(asRole(pool, 'platform_admin', c, { sub: p.a }, (cl) => cl.query(DEMOTE, [c, p.o]), true))).toBe('RC011');
    expect(await roleOf(pool, c, p.o)).toBe(legacy);
  });

  it('a write that leaves it as it is, is no demotion', async () => {
    const c = await company(pool, p, companies, [[p.o, legacy], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'UPDATE company_users SET role = role WHERE company_id = $1 AND user_id = $2', [c, p.o])))).toBe('ok');
  });

  // The canonical owner acts (an admin is RC010 on either row since 909).
  it('but is not counted as the owner left behind: the canonical owner stays (RC005)', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, legacy], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.o, (cl) => cl.query(DEMOTE, [c, p.o])))).toBe('RC005');
    expect(await outcome(asApp(c, p.o, (cl) => cl.query(DEMOTE, [c, p.o2])))).toBe('ok');
  });
});

it.each(['owners', 'co-owner', 'own', 'owner_'])('%j is not owner-ish', async (role) => {
  expect((await pool.query('SELECT public.company_member_role_is_owner($1) AS is', [role])).rows[0].is).toBe(false);
});

/** The predicate's whitespace class: ASCII \t\n\v\f\r and space, then the listed non-ASCII members. */
const CLASS = ['9', 'a', 'b', 'c', 'd', '20', '85', 'a0', '1680', '180e', '2000', '2001', '2002', '2003', '2004', '2005',
  '2006', '2007', '2008', '2009', '200a', '200b', '2028', '2029', '202f', '205f', '2060', '3000', 'feff'];

it.for(['default', 'C', 'en_US.utf8', 'und-x-icu'])(
  'under the %s collation, own<c>er and OWN<c>ER are owner-ish for exactly the class (blind #693 r2: COLLATE "C")', async (collation, ctx) => {
    const exists = collation === 'default' || (await pool.query('SELECT 1 FROM pg_collation WHERE collname = $1', [collation])).rows.length > 0;
    ctx.skip(!exists, `no ${collation} collation on this server`);
    const coll = collation === 'default' ? '' : ` COLLATE "${collation}"`;
    const { rows } = await pool.query(`
      SELECT pg_catalog.string_agg(pg_catalog.to_hex(c), ' ' ORDER BY c) AS hex FROM generate_series(1, 65533) c
      WHERE c NOT BETWEEN 55296 AND 57343
        AND public.company_member_role_is_owner(('own' || chr(c) || 'er')${coll})
        AND public.company_member_role_is_owner(('OWN' || chr(c) || 'ER')${coll})`);
    expect(rows[0].hex.split(' ')).toEqual(CLASS);
  });
