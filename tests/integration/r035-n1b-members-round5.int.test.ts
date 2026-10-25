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
 *    except when it removes or demotes an owner (908b, its last-owner rule);
 *  - owner-ness is company_member_role_is_owner: lower-cased, all whitespace
 *    (ASCII and Unicode) removed. A legacy owner-ish invitation is an owner's
 *    to re-open, and an owner-ish membership is an owner's for the last-owner
 *    rule (886's precondition refuses to apply while either exists; these
 *    rows are written here as the table owner).
 *
 * The portal-vs-app races are r035-n1b-members-takeover's, unchanged.
 *
 * Since S-07d (migration 937) app_user holds no UPDATE or DELETE on
 * company_users either: every app_user write to it is refused by privilege
 * (42501) at any level, before the guard or its isolation check runs. Role
 * changes and removals run on the migration_admin pool, which re-checks these
 * rules in TypeScript, READ COMMITTED (memberWrites.ts); their races are
 * s07d-member-writes.int.test.ts's.
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
// Since S-07c (930) app_user holds no INSERT/UPDATE on company_invitations (the route writes it on the migration_admin pool):
// an app_user write there is refused by privilege (42501) before any guard or isolation check; the seeds below go in as the table owner.
const seedInvite = (c: string, by: string, role: string) => pool.query(INVITE, inviteAs(c, by, role));
const inviteAs = (c: string, by: string, role: string) => [c, emailOf(p.x), role, by, tokenHash(crypto.randomUUID())];

describe.each(['REPEATABLE READ', 'SERIALIZABLE'])('%s: refused (40001) — the snapshot is not re-read after the lock', (level) => {
  it('every app_user write to a membership is refused by privilege (42501, since 937), the guard never reached', async () => {
    const c = await company(pool, p, companies);
    for (const [sub, statement] of [[p.o, DEMOTE], [p.o, REMOVE], [p.a, GRANT],
      [p.a, "UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2"],
      [p.a, 'UPDATE company_users SET role = role WHERE company_id = $1 AND user_id = $2']] as const) {
      expect(await finish(await session(c, sub, level), statement, [c, statement === DEMOTE || statement === REMOVE ? p.o2 : p.m])).toBe('42501');
    }
    expect([await owners(c), await roleOf(pool, c, p.m)]).toEqual([2, 'manager']);
  });

  it('an owner invitation is neither written nor re-shaped (42501 since 930; the 40001 is behind it)', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.o, level), INVITE, inviteAs(c, p.o, 'owner'))).toBe('42501');
    await seedInvite(c, p.o, 'owner');
    expect(await finish(await session(c, p.o, level), RESHAPE, [c])).toBe('42501');
    expect((await pool.query('SELECT count(*)::INT AS n FROM company_invitations WHERE company_id = $1', [c])).rows[0].n).toBe(1);
  });

  it('an invitation is neither inserted (42501 since 930) nor removed (40001), even one that touches no owner', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.a, level), INVITE, inviteAs(c, p.a, 'manager'))).toBe('42501'); // by privilege since 930
    await seedInvite(c, p.a, 'manager');
    expect(await finish(await session(c, p.a, level), 'DELETE FROM company_invitations WHERE company_id = $1', [c])).toBe('40001');
  });

  // Since 908b the portal judges one thing, the last owner (RC011), so removing
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
  it('as app_user, an owner can neither grant owner nor remove an owner (42501 since 937); writing or re-shaping an owner invitation is 42501 since 930', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.o, level), GRANT, [c, p.m])).toBe('42501');
    expect(await finish(await session(c, p.o, level), INVITE, inviteAs(c, p.o, 'owner'))).toBe('42501');
    await seedInvite(c, p.o, 'owner');
    expect(await finish(await session(c, p.o, level), RESHAPE, [c])).toBe('42501');
    expect(await finish(await session(c, p.o, level), REMOVE, [c, p.o2])).toBe('42501');
    expect([await roleOf(pool, c, p.m), await roleOf(pool, c, p.o2)]).toEqual(['manager', 'owner']);
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

  it('an admin cannot re-open the invitation (42501 since 930; the guard\'s RC003 is behind it); it stays expired', async () => {
    const c = await company(pool, p, companies);
    await legacyInvitation(c);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(REOPEN, [c])))).toBe('42501');
    expect((await pool.query('SELECT expires_at < now() AS expired FROM company_invitations WHERE company_id = $1', [c])).rows)
      .toEqual([{ expired: true }]);
  });

  it('an owner cannot either as app_user (42501 since 930; the route re-opens it on the migration_admin pool)', async () => {
    const c = await company(pool, p, companies);
    await legacyInvitation(c);
    expect(await outcome(asApp(c, p.o, (cl) => cl.query(REOPEN, [c])))).toBe('42501');
  });

  // It is an owner's row for 908b's rules too: an admin is refused (RC010), and
  // so is the admin portal (RC011, the exact-'owner' count finds no other).
  it('the only owner-ish membership is not demoted (42501 as app_user since 937, RC011 as the portal)', async () => {
    const c = await company(pool, p, companies, [[p.o, legacy], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(DEMOTE, [c, p.o])))).toBe('42501');
    expect(await outcome(asRole(pool, 'platform_admin', c, { sub: p.a }, (cl) => cl.query(DEMOTE, [c, p.o]), true))).toBe('RC011');
    expect(await roleOf(pool, c, p.o)).toBe(legacy);
  });
  // A no-op write and the last-owner count over owner-ish rows run on the
  // migration_admin pool since 937: s07d-member-writes.int.test.ts.
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
