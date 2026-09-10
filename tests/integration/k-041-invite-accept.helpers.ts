/**
 * Shared fixture + GoTrue stub for the K-041 invite-accept integration specs.
 *
 * Extracted from k-041-invite-accept-overwrites-existing-password.int.test.ts
 * once five rounds of accreted cases pushed that file past the 300-line ceiling
 * in CLAUDE.md. The harness is identical; only its home changed. Each spec file
 * imports this module in its own worker, so every id below is regenerated per
 * file and the two specs never share a row.
 */
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import pg, { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { NextApiRequest } from 'next';

assertDisposable();

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const invitingCompany = crypto.randomUUID();
export const existingCompany = crypto.randomUUID();
export const newInviteeCompany = crypto.randomUUID();
export const existingUser = crypto.randomUUID();
export const newInvitee = crypto.randomUUID();
export const inviter = crypto.randomUUID();
export const email = `k041-${existingUser}@test.local`;
export const newEmail = `k041-new-${newInvitee}@test.local`;
export const token = `k041${'0'.repeat(28)}${existingUser.replace(/-/g, '')}`;
export const newToken = `k041n${'0'.repeat(27)}${newInvitee.replace(/-/g, '')}`;
export const inviteId = crypto.randomUUID();
export const newInviteId = crypto.randomUUID();
/** L4: a fourth company, so the attempt-cap test gets its own invitation row. */
export const cappedCompany = crypto.randomUUID();
export const cappedToken = `k041c${'0'.repeat(27)}${existingUser.replace(/-/g, '')}`;
/**
 * Round-2 L5: an account provisioned before the 10-character floor existed.
 * Its owner must be able to accept an invitation by proving ownership of the
 * password it actually has, not the one our current rule would demand.
 */
export const shortPwCompany = crypto.randomUUID();
export const shortPwUser = crypto.randomUUID();
export const shortPwEmail = `k041s-${shortPwUser}@test.local`;
export const shortPwToken = `k041s${'0'.repeat(27)}${shortPwUser.replace(/-/g, '')}`;
export const SHORT_PASSWORD = 'short1';
/** Round-2 L3: a brand-new invitee whose GoTrue call blows up mid-accept. */
export const outageUser = crypto.randomUUID();
export const outageToken = `k041o${'0'.repeat(27)}${outageUser.replace(/-/g, '')}`;
/**
 * Round-4 L3: the invited address is already held by ANOTHER `users` row
 * (a pre-GoTrue-cutover profile, or a deleted-and-recreated identity).
 * users_email_key raised 23505 through an INSERT that arbitrates only on id.
 */
export const l3User = crypto.randomUUID();
export const l3Legacy = crypto.randomUUID();
export const l3Email = `k041l3-${l3User}@test.local`;
export const l3Token = `k041L${'0'.repeat(27)}${l3User.replace(/-/g, '')}`;
/** Round-4 L4: an established account whose profile email is not the invited one. */
export const l4User = crypto.randomUUID();
export const l4Changed = `k041l4-changed-${l4User}@test.local`;
export const l4Invited = `k041l4-invited-${l4User}@test.local`;
export const l4Token = `k041M${'0'.repeat(27)}${l4User.replace(/-/g, '')}`;
export const L4_PASSWORD = 'low4-real-password-2026';
/** Round-4 L5: names from an anonymous body that are not short strings. */
export const l5User = crypto.randomUUID();
export const l5Email = `k041l5-${l5User}@test.local`;
export const l5Token = `k041N${'0'.repeat(27)}${l5User.replace(/-/g, '')}`;
/** Round-6 M1: a name made entirely of astral characters (surrogate pairs). */
export const astralUser = crypto.randomUUID();
export const astralEmail = `k041a-${astralUser}@test.local`;
export const astralToken = `k041A${'0'.repeat(27)}${astralUser.replace(/-/g, '')}`;

/**
 * Accounts the /token stub resolves by address, added by the round-4 cases.
 * The original stub hard-codes three identities; these need their own.
 */
export const extraAccounts = new Map<string, { id: string; password: string }>();

/**
 * Every rate-limit key this file could have created. The teardown used to wipe
 * `invite-accept:%` wholesale, which would delete a sibling spec's live
 * counters now that two files share the fixture DB and vitest runs files in
 * parallel. Every token in these specs is minted through `stored()`, so
 * recording here covers the ad-hoc ones the tests build inline too.
 */
const seenDigests = new Set<string>();

/** company_invitations.token holds sha256 of the token carried by the link. */
export const stored = (raw: string): string => {
  const digest = createHash('sha256').update(raw).digest('hex');
  seenDigests.add(digest);
  return digest;
};

/**
 * Round-3 L1: accept.ts builds its admin pool privately, which is what made the
 * `if (opened)` guard on ROLLBACK look untestable. It isn't: a spy on
 * pg.Pool.prototype.connect — installed here, before the module under test is
 * imported in beforeAll — sees every client that private pool hands out and
 * records what each one is asked to run. Grouped per client, so the ROLLBACK
 * withInviteToken legitimately issues on its OWN transaction is not confused
 * with one the admin client must never issue.
 */
export const issued: Array<{ clientId: number; sql: string }> = [];
let recording = false;
export function setRecording(on: boolean): void { recording = on; }
let nextClientId = 1;
const CLIENT_ID = Symbol('k041ClientId');
const realConnect = pg.Pool.prototype.connect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function instrument(client: any): unknown {
  if (client && client[CLIENT_ID] === undefined) {
    client[CLIENT_ID] = nextClientId++;
    const realQuery = client.query.bind(client);
    client.query = (...queryArgs: unknown[]) => {
      if (recording && typeof queryArgs[0] === 'string') {
        issued.push({ clientId: client[CLIENT_ID], sql: queryArgs[0] });
      }
      return realQuery(...queryArgs);
    };
  }
  return client;
}
// pg.Pool.connect has two shapes: connect() returns a promise, connect(cb) does
// not. node-postgres itself uses the callback form internally, so patching only
// the promise form is not optional — awaiting the callback form yields
// undefined and every internal checkout throws.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(pg.Pool.prototype as any).connect = function patchedConnect(this: pg.Pool, ...args: unknown[]) {
  if (args.length > 0) {
    const [callback, ...rest] = args;
    return (realConnect as any).apply(this, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: unknown, client: any, done: unknown) => (callback as any)(err, instrument(client), done),
      ...rest,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (realConnect as any).apply(this, args).then(instrument);
};

/** The password the pre-existing account already has. Only GoTrue knows it. */
export const REAL_PASSWORD = 'existing-real-password-2026';

export const passwordPatches: Array<{ userId: string; password?: string }> = [];
/** Round-6 M2: the FULL admin patch body, to assert `email_confirm`. */
export const adminPatches: Array<{ userId: string; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

let accept: typeof import('../../pages/api/invitations/[token]/accept').default;
export function getAccept(): typeof accept { return accept; }

export function acceptRequest(
  inviteToken: string, password: string, remote: string,
  names: { firstName?: unknown; lastName?: unknown } = { firstName: 'K', lastName: '041' },
): NextApiRequest {
  return {
    method: 'POST', url: `/api/invitations/${inviteToken}/accept`, query: { token: inviteToken },
    cookies: {}, headers: {},
    body: { token: inviteToken, password, ...names },
    socket: { remoteAddress: remote },
  } as unknown as NextApiRequest;
}

export async function setupInviteFixture(): Promise<void> {
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', process.env.PLATFORM_ADMIN_DATABASE_URL!);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'disposable-service-role-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'disposable-anon-key');

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)',
    [invitingCompany, 'K041 inviting company', existingCompany, 'K041 existing company',
      newInviteeCompany, 'K041 new-invitee company', cappedCompany, 'K041 attempt-cap company',
      shortPwCompany, 'K041 short-password company']);
  // The victim: an account that already exists and already has a password.
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true),($3,$4,'admin',true),($5,$6,'viewer',true)",
    [existingUser, email, inviter, `k041-inviter-${inviter}@test.local`, shortPwUser, shortPwEmail]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
    [existingCompany, existingUser, invitingCompany, inviter]);
  await pool.query(
    `INSERT INTO company_invitations(id,company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,$3,'viewer',$4,$5,now()+interval '7 days',$6),
           ($7,$8,$9,'manager',$4,$10,now()+interval '7 days',$11)`,
    [inviteId, invitingCompany, email, inviter, stored(token), existingUser,
      newInviteId, newInviteeCompany, newEmail, stored(newToken), newInvitee]);
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, shortPwEmail, inviter, stored(shortPwToken), shortPwUser]);

  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('External network forbidden in disposable invite fixture');
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.startsWith('/admin/users/')) {
      const userId = url.pathname.split('/').pop()!;
      if (userId === outageUser) throw new Error('disposable gotrue outage');
      passwordPatches.push({ userId, password: body.password });
      adminPatches.push({ userId, body });
      return new Response(JSON.stringify({ id: userId, email: userId === existingUser ? email : newEmail }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/token') {
      const extra = extraAccounts.get(body.email);
      if (extra) {
        if (body.password !== extra.password) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }),
            { status: 400, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          access_token: 'disposable-access', refresh_token: 'disposable-refresh',
          expires_in: 3600, token_type: 'bearer',
          user: { id: extra.id, email: body.email },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // GoTrue answers 400 for a wrong password. The pre-existing account keeps
      // REAL_PASSWORD; the brand-new one accepts whatever accept.ts just set.
      const isExisting = body.email === email;
      const isShortPw = body.email === shortPwEmail;
      const patched = passwordPatches.find((p) => p.userId === newInvitee)?.password;
      const ok = isExisting ? body.password === REAL_PASSWORD
        : isShortPw ? body.password === SHORT_PASSWORD
          : body.password === patched;
      if (!ok) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        access_token: 'disposable-access', refresh_token: 'disposable-refresh',
        expires_in: 3600, token_type: 'bearer',
        user: { id: isExisting ? existingUser : isShortPw ? shortPwUser : newInvitee, email: body.email },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  });

  accept = (await import('../../pages/api/invitations/[token]/accept')).default;
}

export async function teardownInviteFixture(): Promise<void> {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).connect = realConnect;
  const companies = [invitingCompany, existingCompany, newInviteeCompany, cappedCompany, shortPwCompany];
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])',
      [[existingUser, inviter, newInvitee, shortPwUser, l3User, l3Legacy, l4User, l5User, astralUser]]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key=ANY($1::text[])',
      [[...seenDigests].map((d) => `invite-accept:${d}`)]);
  } finally { await pool.end(); }
}
