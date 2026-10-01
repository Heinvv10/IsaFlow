/**
 * R-176 — pages/api/invitations/[token]/accept.ts owns a transaction on its own BYPASSRLS pool.
 * A ROLLBACK that failed was logged, and the client was then released bare, back into that
 * pool inside its transaction, for the next invitee's accept to inherit.
 *
 * The route runs as it does in production, on the K-041 harness (real Postgres, GoTrue stubbed
 * at fetch). Its admin pool is private, so the client is found by the first statement only that
 * client runs, and its ROLLBACK / COMMIT is refused before reaching Postgres.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg, { type PoolClient } from 'pg';
import { response } from './mfa-impersonation-postgres.helpers';
import {
  acceptRequest, extraAccounts, getAccept, inviter, newInviteeCompany, pool, setupInviteFixture, stored,
  teardownInviteFixture,
} from './k-041-invite-accept.helpers';
import { arm, backendState, seen, survivesClientError, type ArmOptions, type Seen, type Statement } from './r176-evict.helpers';

/** What each invitee types; generated per run, so no credential is written down here. */
const typed = `r176-${crypto.randomUUID()}`;
const created: string[] = [];

beforeAll(async () => {
  // The K-041 GoTrue stub answers /admin/users/* and /token at the root of the GoTrue origin.
  vi.stubEnv('GOTRUE_URL', new URL(process.env.GOTRUE_URL!).origin);
  await setupInviteFixture();
});
afterAll(async () => {
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [created]);
  await teardownInviteFixture();
});

/** A fresh invitation for a brand-new invitee. `clash`: another users row already holds the address. */
async function invite(clash = false) {
  const userId = crypto.randomUUID();
  const email = `r176-${userId}@test.local`;
  const token = `r176${'0'.repeat(28)}${userId.replace(/-/g, '')}`;
  created.push(userId);
  if (clash) {
    const legacy = crypto.randomUUID();
    created.push(legacy);
    await pool.query('INSERT INTO users(id,email,is_active) VALUES($1,$2,true)', [legacy, email]);
  }
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [newInviteeCompany, email, inviter, stored(token), userId]);
  extraAccounts.set(email, { id: userId, password: typed });
  return { userId, token };
}

/**
 * Arms the accept route's admin client for one request. Every pool checkout is watched; the
 * admin client is the one that runs the route's `users` lookup, and only it is refused.
 */
function armAcceptClient(fail: Statement[], s: Seen, opts: ArmOptions = {}): void {
  const proto = pg.Pool.prototype as unknown as { connect: (...a: unknown[]) => unknown };
  const before = proto.connect;
  s.disarm = () => { proto.connect = before; };
  proto.connect = function watched(this: unknown, ...a: unknown[]) {
    const out = before.apply(this, a);
    if (a.length > 0) return out;
    if (!s.pools.includes(this as pg.Pool)) s.pools.push(this as pg.Pool);
    return (out as Promise<PoolClient>).then((client) => {
      const real = client.query as (...q: unknown[]) => unknown;
      const restore = s.disarm;
      s.disarm = () => { Object.assign(client, { query: real }); restore(); };
      Object.assign(client, {
        query: (...q: unknown[]) => {
          if (typeof q[0] === 'string' && q[0].includes('SELECT id FROM users WHERE id = $1')) {
            Object.assign(client, { query: real });
            s.pid = (client as unknown as { processID: number }).processID;
            arm(client, fail, s, opts); // from here on this client's ROLLBACK / COMMIT / BEGIN fail
          }
          return real.apply(client, q);
        },
      });
      return client;
    });
  };
}

async function accept(token: string, fail: Statement[], s: Seen, opts: ArmOptions = {}): Promise<number> {
  const result = response();
  armAcceptClient(fail, s, opts);
  try {
    await getAccept()(acceptRequest(token, typed, '127.0.0.176'), result.res);
  } finally {
    s.disarm();
  }
  return result.state.statusCode;
}

const member = async (userId: string) =>
  (await pool.query('SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2', [newInviteeCompany, userId])).rowCount;

/** One accept, then a healthy one by another invitee. Gathered before anything is asserted. */
async function acceptThenNext(first: { userId: string; token: string }, fail: Statement[], want: 'gone' | 'idle') {
  const s = seen();
  const status = await accept(first.token, fail, s);
  const state = await backendState(pool, s.pid, want);
  const other = await invite();
  const n = seen();
  const nextStatus = await accept(other.token, [], n);
  // Hygiene for a failing run only: a connection left in its transaction would fail every later case.
  if (want === 'gone' && state !== null) await pool.query('SELECT pg_terminate_backend($1)', [s.pid]);
  return {
    status, refused: s.refused, state, samePid: n.pid === s.pid, nextStatus, pools: s.pools,
    member: await member(first.userId), nextMember: await member(other.userId),
  };
}

it('EMAIL_IN_USE whose ROLLBACK fails: the connection is destroyed and the next invitee is still served', async () => {
  const r = await acceptThenNext(await invite(true), ['ROLLBACK'], 'gone');
  expect(r.refused.ROLLBACK).toBe(2); // the route's own ROLLBACK, then the one in its catch
  expect(r.status).toBe(500);
  expect(r.nextStatus).toBe(200); // not handed a connection inside an aborted transaction
  expect(r.member).toBe(0);
  expect(r.nextMember).toBe(1);
  expect(r.samePid).toBe(false);
  expect(r.state).toBeNull();
});

it('a COMMIT that fails, and then its ROLLBACK: the next accept cannot commit the failed membership', async () => {
  const r = await acceptThenNext(await invite(), ['COMMIT', 'ROLLBACK'], 'gone');
  expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 1 });
  expect(r.status).toBe(500);
  expect(r.nextStatus).toBe(200);
  // withInviteToken's pool and the route's admin pool: a destroyed client's error must not crash the process.
  expect(r.pools.map(survivesClientError)).toEqual([true, true]);
  expect(r.member).toBe(0); // the invitee was told 500; the membership must not exist
  expect(r.nextMember).toBe(1);
  expect(r.samePid).toBe(false);
  expect(r.state).toBeNull();
});

it('EMAIL_IN_USE whose ROLLBACK succeeds: 409, and the connection is reused', async () => {
  const r = await acceptThenNext(await invite(true), [], 'idle');
  expect(r.status).toBe(409);
  expect(r.member).toBe(0);
  expect(r.state).toBe('idle');
  expect(r.samePid).toBe(true);
  expect(r.nextStatus).toBe(200);
});

it('a COMMIT that fails but whose ROLLBACK succeeds: rolled back, and the connection is reused', async () => {
  const r = await acceptThenNext(await invite(), ['COMMIT'], 'idle');
  expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 0 });
  expect(r.status).toBe(500);
  expect(r.member).toBe(0);
  expect(r.state).toBe('idle');
  expect(r.samePid).toBe(true);
});

it('an accepted invitation: committed, and the connection is reused', async () => {
  const r = await acceptThenNext(await invite(), [], 'idle');
  expect(r.status).toBe(200);
  expect(r.member).toBe(1);
  expect(r.state).toBe('idle');
  expect(r.samePid).toBe(true);
});

it('a BEGIN that fails after it reached the server: rolled back, not pooled inside the open transaction', async () => {
  const first = await invite();
  const s = seen();
  const status = await accept(first.token, [], s, { beginFailsAfterSend: true });
  const state = await backendState(pool, s.pid, 'idle');
  if (state !== 'idle') await pool.query('SELECT pg_terminate_backend($1)', [s.pid]); // hygiene for a failing run
  expect(s.beginFailed).toBe(1);
  expect(status).toBe(500);
  expect(state).toBe('idle'); // not 'idle in transaction'
  expect(await member(first.userId)).toBe(0);
});
