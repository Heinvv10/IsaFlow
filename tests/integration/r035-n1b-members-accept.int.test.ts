/**
 * R-035 N1b (C) — adversarial review of PR #691, round 5, REPRO 1: an admin
 * re-invites the company's last owner, by the owner's own address, at
 * `viewer` through POST /api/invitations (which checks no membership); the
 * owner follows the emailed link, and the accept route's
 * `ON CONFLICT … DO UPDATE SET role` made them a viewer — no owner left. The
 * accept routes write as roles the guard does not judge, so the routes refuse
 * it themselves: an acceptance never overwrites an owner's role, and the
 * invitation is still accepted.
 *
 * Real routes on the disposable database; only GoTrue and the mailer are
 * stubbed. Both accept routes: /api/invite/<token> (signed in) and
 * /api/invitations/<token>/accept (password).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import {
  acceptAsInvitee, cleanupMembers, company, emailOf, jwtFor, people, roleOf, tokenHash, type People,
} from './r035-n1b-members.helpers';

const sent: { to: string; html: string }[] = [];
const gotrueId = { current: '' };
const PASSWORD = 'n1b-r5-pw';
vi.mock('@/lib/auth/gotrue', async (orig) => ({
  ...(await orig<object>()),
  // GoTrue answers 422 for an existing address and adminCreateUser returns that user.
  adminCreateUser: vi.fn(async () => ({ id: gotrueId.current })),
  signIn: vi.fn(async (email: string, password: string) => {
    if (password !== PASSWORD) throw new Error('invalid_grant');
    return { access_token: 'n1b-access', refresh_token: 'n1b-refresh', expires_in: 3600, token_type: 'bearer',
      user: { id: gotrueId.current, email } };
  }),
}));
vi.mock('@/modules/accounting/services/core/emailService', async (orig) => ({
  ...(await orig<object>()),
  sendEmail: vi.fn(async (m: { to: string; html: string }) => { sent.push(m); return { success: true }; }),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const rateKeys: string[] = [];
const IP = '127.0.0.195';
let p: People;

beforeAll(async () => {
  // As k-041-invite-accept.helpers: the accept route's admin pool on the fixture's login role.
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', process.env.PLATFORM_ADMIN_DATABASE_URL!);
  p = await people(pool, users);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1)', [rateKeys]);
  await cleanupMembers(pool, companies, users);
});

/** The admin re-invites the last owner at viewer through the real route; returns the emailed raw token. */
async function adminInvitesOwnerAsViewer(c: string): Promise<string> {
  gotrueId.current = p.o;
  const route = (await import('../../pages/api/invitations/index')).default;
  const res = await callRoute(route, await jwtFor(p.a), c, 'POST', { email: emailOf(p.o), role: 'viewer' }, '/api/invitations');
  expect(res.state.statusCode).toBe(201);
  expect(sent.at(-1)!.to).toBe(emailOf(p.o));
  const raw = /token=([0-9a-f]{64})/.exec(sent.at(-1)!.html)![1]!;
  rateKeys.push(`invitations:company:${c}`, `invite-accept:${tokenHash(raw)}`);
  return raw;
}

async function expectOwnerKeptAndAccepted(c: string) {
  expect(await roleOf(pool, c, p.o)).toBe('owner');
  expect((await pool.query(
    "SELECT role, accepted_at IS NOT NULL AS accepted FROM company_invitations WHERE company_id = $1", [c])).rows)
    .toEqual([{ role: 'viewer', accepted: true }]);
}

describe("an admin's lesser invitation to the last owner, accepted by the owner", () => {
  it('/api/invite/<token>: the owner stays owner; the invitation is accepted', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.a, 'admin']]);
    const raw = await adminInvitesOwnerAsViewer(c);
    expect((await acceptAsInvitee(p.o, raw)).state.statusCode).toBe(200);
    await expectOwnerKeptAndAccepted(c);
  });

  it('/api/invitations/<token>/accept: the owner stays owner; the invitation is accepted', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.a, 'admin']]);
    const raw = await adminInvitesOwnerAsViewer(c);
    rateKeys.push(`invite-accept-by-ip:ip:${IP}`);
    const accept = (await import('../../pages/api/invitations/[token]/accept')).default;
    const result = response();
    await accept({
      method: 'POST', url: `/api/invitations/${raw}/accept`, query: { token: raw }, cookies: {}, headers: {},
      body: { token: raw, password: PASSWORD }, socket: { remoteAddress: IP },
    } as never, result.res as never);
    expect(result.state.statusCode).toBe(200);
    await expectOwnerKeptAndAccepted(c);
  });
});
