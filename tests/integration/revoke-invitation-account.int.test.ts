/**
 * POST /api/invitations/revoke/[id] deletes the invitation, and the GoTrue account pinned to it only when that
 * account is the invitation's own unused placeholder (#1517 review). It is deleted only when all of these hold:
 * - this invitation created it (`user_metadata.invite_id`, stamped by POST /api/invitations; createInvitation in
 *   Settings creates no account and stamps nothing, so a Settings pin is never deleted);
 * - nobody has ever signed in to it (`last_sign_in_at` empty; breaker B1);
 * - it has no membership and no OTHER pending invitation pinned to it, in any company (read on the migration_admin
 *   pool, past RLS; breaker B2: another company's invitation would otherwise be stuck on IDENTITY_MISMATCH).
 *
 * Real route, real PG (the s07b fixture: the app pools as production's logins). GoTrue is a fetch stub that
 * records calls; adminGetUser answers what this file says each account is. No email is sent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('@/lib/auth/gotrueAdminUser', () => ({
  adminGetUser: async (id: string) => (accounts.has(id) ? { id, ...accounts.get(id) } : null),
}));
import revokeRoute from '../../pages/api/invitations/revoke/[id]';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { json, stubGotrue } from './s07c-credential-paths.helpers';

const ids = newIds();
const { me, company, other } = ids;

beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]));
afterEach(() => { vi.unstubAllGlobals(); });

/** A pending invitation to `co` pinned to `pinned`; returns its id. */
async function pendingInvitation(co: string, pinned: string, opts: { accepted?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.query(
    `INSERT INTO company_invitations (id, company_id, email, role, invited_by, token, expires_at, gotrue_user_id, accepted_at)
     VALUES ($1, $2, $3, 'viewer', $4, $5, now() + interval '7 days', $6, $7)`,
    [id, co, `revoke-${id}@test.local`, me, `revoke-${id}`, pinned, opts.accepted ? new Date() : null]);
  return id;
}

/** Revokes `id` in `company` as its admin; returns the GoTrue DELETEs it made. */
async function revoke(id: string, account: string): Promise<string[]> {
  const calls = stubGotrue(({ method, path }) => (method === 'DELETE' && path === `/admin/users/${account}` ? json(200, {}) : undefined));
  const r = await callRoute(revokeRoute, { sub: me, method: 'POST', companyId: company, query: { id } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await fixture.query('SELECT 1 FROM company_invitations WHERE id = $1', [id])).rowCount).toBe(0);
  return calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
}

describe('revoke removes only its own unused placeholder', () => {
  it('created by this invitation, never signed in, nothing else pinned to it: deleted', async () => {
    const x = crypto.randomUUID();
    const id = await pendingInvitation(company, x);
    accounts.set(x, { email: 'x@test.local', user_metadata: { invite_id: id } });
    expect(await revoke(id, x)).toEqual([`/admin/users/${x}`]);
  });

  it('B1: created by this invitation but signed in since: the invitation goes, the account stays', async () => {
    const x = crypto.randomUUID();
    const id = await pendingInvitation(company, x);
    accounts.set(x, { email: 'x@test.local', user_metadata: { invite_id: id }, last_sign_in_at: '2026-11-10T08:00:00Z' });
    expect(await revoke(id, x)).toEqual([]);
  });

  it("B2: another company's pending invitation is pinned to it: the account stays for that invitation", async () => {
    const x = crypto.randomUUID();
    const id = await pendingInvitation(company, x);
    const theirs = await pendingInvitation(other, x);
    accounts.set(x, { email: 'x@test.local', user_metadata: { invite_id: id } });
    expect(await revoke(id, x)).toEqual([]);
    expect((await fixture.query('SELECT gotrue_user_id FROM company_invitations WHERE id = $1', [theirs])).rows)
      .toEqual([{ gotrue_user_id: x }]);
  });

  it("B2 adjacent: another company's ACCEPTED invitation does not keep it (it is not waiting on the account)", async () => {
    const x = crypto.randomUUID();
    const id = await pendingInvitation(company, x);
    await pendingInvitation(other, x, { accepted: true });
    accounts.set(x, { email: 'x@test.local', user_metadata: { invite_id: id } });
    expect(await revoke(id, x)).toEqual([`/admin/users/${x}`]);
  });

  it('a Settings pin (an account that already held the address, created by no invitation): the account stays', async () => {
    const x = crypto.randomUUID();
    const id = await pendingInvitation(company, x);
    accounts.set(x, { email: 'x@test.local', user_metadata: {} });
    expect(await revoke(id, x)).toEqual([]);
  });
});
