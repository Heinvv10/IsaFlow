/**
 * Package B (admin follow-ups 2026-11-16): the race #1440 left open.
 *
 * Two brand-new invitees whose addresses differ only in letter case accept at the same instant
 * through POST /api/invitations/<token>/accept. inviteeProfile.ts's lower() read could not see the
 * other's uncommitted row, users_email_key compared exact text, and both committed: two profiles
 * for one mailbox. Now the address is stored lower(btrim(email)) and users_email_lower_key (999)
 * holds one row per normal form, so the second INSERT waits on the first and then fails: one 200,
 * one 409 EMAIL_IN_USE.
 *
 * The barrier holds each accept just before it marks its invitation (after its users INSERT,
 * before COMMIT) until the other accept has also got there, or is seen waiting on a lock in its
 * own users INSERT. So both reads always run before either row commits: the interleaving that
 * gave two profiles.
 *
 * Also: a mixed-case invitation address is stored lower-cased and trimmed by this route.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { response } from './mfa-impersonation-postgres.helpers';
import {
  acceptRequest, extraAccounts, getAccept, inviter, pool, setupInviteFixture, shortPwCompany, stored,
  teardownInviteFixture,
} from './k-041-invite-accept.helpers';

const created: string[] = [];
const MARK = /^\s*UPDATE company_invitations SET accepted_at/;
const barrier = { armed: false, arrived: 0 };
const WRAPPED = Symbol('emailCaseRaceBarrier');
let restoreConnect: (() => void) | null = null;

/** Returns once the other accept has reached the mark too, or is blocked on a lock in its users INSERT. */
async function waitForPeer(): Promise<void> {
  barrier.arrived += 1;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (barrier.arrived >= 2) return;
    const waiting = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO users%'`);
    if (waiting.rows[0]!.n > 0) return;
    if (Date.now() > deadline) throw new Error('barrier: the other accept neither reached the mark nor waited on a lock');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every client the route's migration_admin pool hands out stops at MARK while the barrier is armed. */
function installBarrier(): void {
  const p = migrationAdminPool();
  const realConnect = p.connect;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).connect = async function barrierConnect(this: unknown, ...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (args.length > 0) return (realConnect as any).apply(p, args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = await (realConnect as any).apply(p, []);
    if (!client[WRAPPED]) {
      client[WRAPPED] = true;
      const query = client.query.bind(client);
      client.query = (...q: unknown[]) => (barrier.armed && typeof q[0] === 'string' && MARK.test(q[0])
        ? waitForPeer().then(() => query(...q))
        : query(...q));
    }
    return client;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  restoreConnect = () => { (p as any).connect = realConnect; };
}

interface Invitee { id: string; email: string; token: string; password: string }
async function invitee(email: (tag: string) => string, n: number): Promise<Invitee> {
  const id = randomUUID();
  created.push(id);
  const tag = id.replace(/-/g, '');
  const i = { id, email: email(tag), token: `emc${n}${'0'.repeat(28)}${tag}`, password: `email-case-${tag}` };
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, i.email, inviter, stored(i.token), i.id]);
  extraAccounts.set(i.email, { id: i.id, password: i.password });
  return i;
}
const usersByNormalForm = async (email: string) => (await pool.query(
  'SELECT id, email FROM users WHERE lower(btrim(email)) = lower(btrim($1)) ORDER BY id', [email])).rows;
const memberships = async (ids: string[]) => (await pool.query(
  'SELECT user_id FROM company_users WHERE company_id = $1 AND user_id = ANY($2) ORDER BY user_id', [shortPwCompany, ids])).rows;
const acceptedAt = async (token: string) => (await pool.query(
  'SELECT accepted_at FROM company_invitations WHERE token = $1', [stored(token)])).rows[0]?.accepted_at;

beforeAll(async () => {
  await setupInviteFixture();
  installBarrier();
});
afterAll(async () => {
  restoreConnect?.();
  // Before the fixture's teardown, which ends the pool.
  await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::text[])', [created]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [created]);
  await teardownInviteFixture();
});

describe('users.email case race on POST /api/invitations/<token>/accept', () => {
  it('two brand-new invitees whose addresses differ only in case, at once: one 200, one 409 EMAIL_IN_USE, one profile', async () => {
    const shared = randomUUID();
    const a = await invitee(() => `Race-${shared}@Case.Test`, 1);
    const b = await invitee(() => `race-${shared}@case.test`, 2);
    const [ra, rb] = [response(), response()];
    barrier.armed = true;
    barrier.arrived = 0;
    try {
      await Promise.all([
        getAccept()(acceptRequest(a.token, a.password, '127.0.0.101'), ra.res),
        getAccept()(acceptRequest(b.token, b.password, '127.0.0.102'), rb.res),
      ]);
    } finally {
      barrier.armed = false;
    }
    const results = [{ who: a, r: ra.state }, { who: b, r: rb.state }];
    const detail = JSON.stringify(results.map((x) => ({ status: x.r.statusCode, body: x.r.body })));
    expect(results.map((x) => x.r.statusCode).sort(), detail).toEqual([200, 409]);
    const winner = results.find((x) => x.r.statusCode === 200)!.who;
    const loser = results.find((x) => x.r.statusCode === 409)!;
    expect(loser.r.body).toMatchObject({ error: { code: 'EMAIL_IN_USE' } });
    expect(await usersByNormalForm(a.email)).toEqual([{ id: winner.id, email: `race-${shared}@case.test` }]);
    expect(await memberships([a.id, b.id])).toEqual([{ user_id: winner.id }]);
    expect(await acceptedAt(winner.token)).not.toBeNull();
    expect(await acceptedAt(loser.who.token)).toBeNull();
  });

  it('a brand-new invitee whose invitation address is mixed-case with spaces: the profile stores it lower-cased and trimmed', async () => {
    const i = await invitee((tag) => ` Mixed-${tag}@Case.Test `, 3);
    const r = response();
    await getAccept()(acceptRequest(i.token, i.password, '127.0.0.103'), r.res);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
    expect((await pool.query('SELECT email FROM users WHERE id = $1', [i.id])).rows)
      .toEqual([{ email: i.email.trim().toLowerCase() }]);
  });
});
