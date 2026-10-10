/**
 * R-035 N1b (C), migration 886 — adversarial review of PR #691, round 5:
 *
 *  - REPEATABLE READ: 883's last-owner lock serialises the writers, but a
 *    REPEATABLE READ writer re-reads nothing after the wait, so two of them
 *    each demoting one of two owners left none; and an owner demoted after
 *    the snapshot could still grant owner from it. Under REPEATABLE READ every
 *    owner grant, owner demotion or removal and owner-invitation write is
 *    refused (40001); a write that touches no owner is not;
 *  - owner-ness is trimmed and lower-cased: a legacy `Owner ` invitation is an
 *    owner's to re-open, and a legacy `Owner ` membership is an owner's for the
 *    last-owner rule.
 *
 * READ COMMITTED races are r035-n1b-members-takeover's, unchanged.
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
async function session(c: string, sub: string, level = 'REPEATABLE READ'): Promise<PoolClient> {
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

describe('REPEATABLE READ (40001)', () => {
  it('two sessions each demoting one of two owners: both refused, the owners stay', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'owner'], [p.a, 'admin']]);
    const one = await session(c, p.a);
    const two = await session(c, p.a); // its snapshot predates the first's commit
    const first = await finish(one, DEMOTE, [c, p.o2]);
    const second = await finish(two, DEMOTE, [c, p.o]);
    expect([first, second, await owners(c)]).toEqual(['40001', '40001', 2]);
  });

  it('the removal of an owner too', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.a), 'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [c, p.o2])).toBe('40001');
    expect(await owners(c)).toBe(2);
  });

  it('an owner demoted after the snapshot cannot grant owner from it', async () => {
    const c = await company(pool, p, companies);
    const stale = await session(c, p.o); // o is an owner in this snapshot
    expect(await outcome(asApp(c, p.o2, (cl) => cl.query(DEMOTE, [c, p.o])))).toBe('ok');
    expect(await finish(stale, "UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2", [c, p.m])).toBe('40001');
    expect([await roleOf(pool, c, p.o), await roleOf(pool, c, p.m)]).toEqual(['admin', 'manager']);
  });

  it('an owner invitation is neither written nor re-shaped', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.o), INVITE, [c, emailOf(p.x), 'owner', p.o, tokenHash(crypto.randomUUID())])).toBe('40001');
    await asApp(c, p.o, (cl) => cl.query(INVITE, [c, emailOf(p.x), 'owner', p.o, tokenHash(crypto.randomUUID())]));
    expect(await finish(await session(c, p.o),
      "UPDATE company_invitations SET expires_at = now() + interval '30 days' WHERE company_id = $1", [c])).toBe('40001');
  });

  it('a write that touches no owner is not refused', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.a), "UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [c, p.m])).toBe('ok');
    expect(await finish(await session(c, p.a), INVITE, [c, emailOf(p.x), 'manager', p.a, tokenHash(crypto.randomUUID())])).toBe('ok');
    expect(await roleOf(pool, c, p.m)).toBe('viewer');
  });

  it('READ COMMITTED: the same demotion of a non-last owner goes through', async () => {
    const c = await company(pool, p, companies);
    expect(await finish(await session(c, p.a, 'READ COMMITTED'), DEMOTE, [c, p.o2])).toBe('ok');
    expect(await owners(c)).toBe(1);
  });
});

describe('a legacy `Owner ` role is an owner\'s', () => {
  /** An expired owner invitation stored before the allow-list, role `Owner `. */
  async function legacyInvitation(c: string) {
    await pool.query(`INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
      VALUES($1,$2,'Owner ',$3,$4, now() - interval '1 day')`, [c, emailOf(p.x), p.o, tokenHash(crypto.randomUUID())]);
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

  it('the only owner-ish membership, `Owner `, is not demoted (RC005)', async () => {
    const c = await company(pool, p, companies, [[p.o, 'Owner '], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(DEMOTE, [c, p.o])))).toBe('RC005');
    expect(await roleOf(pool, c, p.o)).toBe('Owner ');
  });

  it('a write that leaves it `Owner ` is no demotion', async () => {
    const c = await company(pool, p, companies, [[p.o, 'Owner '], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'UPDATE company_users SET role = role WHERE company_id = $1 AND user_id = $2', [c, p.o])))).toBe('ok');
  });

  it('but is not counted as the owner left behind: the canonical owner stays (RC005)', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'Owner '], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(DEMOTE, [c, p.o])))).toBe('RC005');
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(DEMOTE, [c, p.o2])))).toBe('ok');
  });
});
