/**
 * R-035 N1b (C, migration 883), review round 1 on PR #691:
 *
 *  - an `owner` invitation cannot be taken over by a non-owner: re-pointed
 *    (email, token, GoTrue user), re-opened (accepted_at, expires_at) or
 *    upserted over while it stays `owner` (blind H1, adversarial REPRO 1–2);
 *    an admin may still turn it into a lesser invitation (a re-invite);
 *  - two owners demoting each other at once: the second, judged after the
 *    first commits, is refused (REPRO 4); a duplicate row of one user does not
 *    count as a second owner (REPRO 3, case variant);
 *  - the invitation role list and the company pin, and the portal's DELETE
 *    of an invitation, each refuse (REPRO 5, blind test gaps).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRole, outcome } from './r035-n1.helpers';
import {
  acceptAsInvitee, cleanupMembers, company, emailOf, people, roleOf, tokenHash, type People,
} from './r035-n1b-members.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
let p: People;

beforeAll(async () => { p = await people(pool, users); });
afterAll(() => cleanupMembers(pool, companies, users));

const asApp = (c: string, sub: string, fn: (cl: PoolClient) => Promise<unknown>) => asRole(pool, 'app_user', c, { sub }, fn, true);
const INVITE = `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
                VALUES($1,$2,$3,$4,$5, now() + interval '7 days')`;
/** An owner's legitimate owner invitation for an outsider's address. */
async function ownerInvitation(c: string) {
  await asApp(c, p.o, (cl) => cl.query(INVITE, [c, 'ceo@n1bc.test', 'owner', p.o, tokenHash(crypto.randomUUID())]));
}
const invitations = async (c: string) => (await pool.query(
  'SELECT email, role, token, accepted_at IS NOT NULL AS accepted FROM company_invitations WHERE company_id = $1', [c])).rows;

describe("an admin cannot take over an owner's invitation", () => {
  it.each([
    ['re-point its email and token', "UPDATE company_invitations SET email = $2, token = $3, expires_at = now() + interval '30 days' WHERE company_id = $1 AND role = 'owner'"],
    ['re-point its GoTrue user', "UPDATE company_invitations SET gotrue_user_id = gen_random_uuid() WHERE company_id = $1 AND role = 'owner' AND $2::TEXT IS NOT NULL AND $3::TEXT IS NOT NULL"],
    ['upsert over it keeping role owner', `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
       VALUES($1,'ceo@n1bc.test','viewer',current_setting('request.jwt.claims')::jsonb->>'sub',$3, now() + interval '7 days')
       ON CONFLICT (company_id,email) DO UPDATE SET token = EXCLUDED.token, email = $2, role = company_invitations.role`],
  ])('%s (RC003) — and the accept finds nothing', async (_label, statement) => {
    const c = await company(pool, p, companies);
    await ownerInvitation(c);
    const before = await invitations(c);
    const raw = `n1bt${'0'.repeat(28)}${crypto.randomUUID().replace(/-/g, '')}`;
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(statement, [c, emailOf(p.x), tokenHash(raw)])))).toBe('RC003');
    expect(await invitations(c)).toEqual(before);
    expect((await acceptAsInvitee(p.x, raw)).state.statusCode).toBe(404);
    expect(await roleOf(pool, c, p.x)).toBeNull();
  });

  it.each([
    ['its email alone', "UPDATE company_invitations SET email = 'other@n1bc.test' WHERE company_id = $1 AND role = 'owner'"],
    ['its token alone', "UPDATE company_invitations SET token = md5(random()::text) WHERE company_id = $1 AND role = 'owner'"],
    ['its expiry alone (reviving it)', "UPDATE company_invitations SET expires_at = now() + interval '90 days' WHERE company_id = $1 AND role = 'owner'"],
    ['its sender, to the admin', "UPDATE company_invitations SET invited_by = current_setting('request.jwt.claims')::jsonb->>'sub' WHERE company_id = $1 AND role = 'owner'"],
  ])('change %s (RC003)', async (_label, statement) => {
    const c = await company(pool, p, companies);
    await ownerInvitation(c);
    const before = await invitations(c);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(statement, [c])))).toBe('RC003');
    expect(await invitations(c)).toEqual(before);
  });

  it('re-open an accepted owner invitation (RC003)', async () => {
    const c = await company(pool, p, companies);
    await ownerInvitation(c);
    await pool.query('UPDATE company_invitations SET accepted_at = now() WHERE company_id = $1', [c]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'UPDATE company_invitations SET accepted_at = NULL WHERE company_id = $1', [c])))).toBe('RC003');
  });

  it('but may turn it into a lesser invitation (a re-invite at another role), and mark its email sent', async () => {
    const c = await company(pool, p, companies);
    await ownerInvitation(c);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'UPDATE company_invitations SET email_sent_at = now(), email_error = NULL WHERE company_id = $1', [c])))).toBe('ok');
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(`${INVITE}
      ON CONFLICT (company_id,email) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by,
        token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, accepted_at = NULL`,
      [c, 'ceo@n1bc.test', 'viewer', p.a, tokenHash(crypto.randomUUID())])))).toBe('ok');
    expect((await invitations(c)).map((i) => i.role)).toEqual(['viewer']);
  });
});

/** Waits until backend `pid` waits on a lock. */
async function blocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])).rows.length) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`backend ${pid} never blocked`);
}

async function session(c: string, sub: string): Promise<PoolClient> {
  const cl = await pool.connect();
  await cl.query('BEGIN');
  await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, session_id: crypto.randomUUID() })]);
  await cl.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
  await cl.query('SET LOCAL ROLE app_user');
  return cl;
}

describe('the last owner', () => {
  it('two owners demoting each other at once: the second is judged after the first commits, and refused (RC005)', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'owner']]);
    const one = await session(c, p.o);
    const two = await session(c, p.o2);
    try {
      await one.query("UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", [c, p.o2]);
      const pid = (await two.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const second = two.query("UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", [c, p.o])
        .then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
      await blocked(pid);
      await one.query('COMMIT');
      expect(await second).toBe('RC005');
    } finally {
      await two.query('ROLLBACK').catch(() => undefined);
      await one.query('ROLLBACK').catch(() => undefined);
      one.release();
      two.release();
    }
    expect([await roleOf(pool, c, p.o), await roleOf(pool, c, p.o2)]).toEqual(['owner', 'admin']);
  });

  it('a portal demotion and an app demotion of the other owner: the app one waits for the portal, then is refused (RC005)', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.o2, 'owner']]);
    const portal = await pool.connect();
    const app = await session(c, p.o2);
    try {
      await portal.query('BEGIN');
      await portal.query('SET LOCAL ROLE platform_admin');
      await portal.query("UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", [c, p.o]);
      const pid = (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const appDemotion = app.query("UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", [c, p.o2])
        .then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
      await blocked(pid);
      await portal.query('COMMIT');
      expect(await appDemotion).toBe('RC005');
    } finally {
      await app.query('ROLLBACK').catch(() => undefined);
      await portal.query('ROLLBACK').catch(() => undefined);
      app.release();
      portal.release();
    }
    expect([await roleOf(pool, c, p.o), await roleOf(pool, c, p.o2)]).toEqual(['admin', 'owner']);
  });

  it("a duplicate row of the same user, in another case, is not a second owner (RC005)", async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.a, 'admin']]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1, upper($2), 'owner')", [c, p.o]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      "UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [c, p.o])))).toBe('RC005');
  });
});

describe('invitation rules with no other test', () => {
  it.each(['Owner', 'OWNER', 'owner ', 'super_admin', 'accountant'])('a role off the invitation list: %j (RC002)', async (role) => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(INVITE, [c, emailOf(p.x), role, p.a, tokenHash(crypto.randomUUID())])))).toBe('RC002');
  });

  it("an owner of another company cannot move this company's invitation there (RC004)", async () => {
    const c = await company(pool, p, companies);
    const d = await company(pool, p, companies, [[p.m, 'owner']]); // m: manager of c, owner of d
    await asApp(c, p.o, (cl) => cl.query(INVITE, [c, emailOf(p.x), 'viewer', p.o, tokenHash(crypto.randomUUID())]));
    expect(await outcome(asRole(pool, 'app_user', d, { sub: p.m }, (cl) => cl.query(
      'UPDATE company_invitations SET company_id = $1 WHERE company_id = $2', [d, c]), true))).toBe('RC004');
    expect((await invitations(c)).length).toBe(1);
  });

  it('the admin portal cannot delete an invitation (RC008)', async () => {
    const c = await company(pool, p, companies);
    await ownerInvitation(c);
    expect(await outcome(asRole(pool, 'platform_admin', c, { sub: p.o }, (cl) => cl.query(
      'DELETE FROM company_invitations WHERE company_id = $1', [c]), true))).toBe('RC008');
  });
});
