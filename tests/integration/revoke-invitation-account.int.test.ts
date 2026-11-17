/**
 * POST /api/invitations/revoke/[id] deletes the invitation, and the GoTrue account pinned to it only when that
 * account is the invitation's own unused placeholder (#1517 review). It is deleted only when all of these hold:
 * - an invitation created it (`user_metadata.invite_id`, stamped by POST /api/invitations; any invitation's, so a
 *   placeholder another company's invitation also pinned is not orphaned once both are revoked; createInvitation in
 *   Settings creates no account and stamps nothing, so a Settings pin is never deleted);
 * - nobody has ever signed in to it (`last_sign_in_at` empty; breaker B1);
 * - it has no membership and no OTHER live (unaccepted, unexpired) invitation pinned to it, in any company (read on
 *   the migration_admin pool, past RLS; breaker B2: another company's invitation would otherwise be stuck on
 *   IDENTITY_MISMATCH), counted again right before the delete (round 2, REPRO 7).
 *
 * Real route, real PG (the s07b fixture: the app pools as production's logins). GoTrue is a fetch stub that
 * records calls; adminGetUser answers what this file says each account is. No email is sent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map<string, Record<string, unknown>>());
/** Runs inside revoke's GoTrue read, between its first count and the delete (REPRO 7). */
const onGet = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }));
vi.mock('@/lib/auth/gotrueAdminUser', () => ({
  adminGetUser: async (id: string) => {
    if (onGet.fn) await onGet.fn();
    return accounts.has(id) ? { id, ...accounts.get(id) } : null;
  },
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
afterEach(() => { vi.unstubAllGlobals(); onGet.fn = null; });

/** A pending invitation to `co` pinned to `pinned`; returns its id. */
async function pendingInvitation(co: string, pinned: string, opts: { accepted?: boolean; expired?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.query(
    `INSERT INTO company_invitations (id, company_id, email, role, invited_by, token, expires_at, gotrue_user_id, accepted_at)
     VALUES ($1, $2, $3, 'viewer', $4, $5, now() + ($8 || ' days')::interval, $6, $7)`,
    [id, co, `revoke-${id}@test.local`, me, `revoke-${id}`, pinned, opts.accepted ? new Date() : null, opts.expired ? '-1' : '7']);
  return id;
}

/** Revokes `id` in `co` (default `company`) as its admin; returns the GoTrue DELETEs it made. */
async function revoke(id: string, account: string, co = company): Promise<string[]> {
  const calls = stubGotrue(({ method, path }) => (method === 'DELETE' && path === `/admin/users/${account}` ? json(200, {}) : undefined));
  const r = await callRoute(revokeRoute, { sub: me, method: 'POST', companyId: co, query: { id } });
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

  it("round 2 REPRO 5: A's placeholder that B also pinned is deleted when the last invitation naming it is revoked", async () => {
    const x = crypto.randomUUID();
    const a = await pendingInvitation(company, x);
    const b = await pendingInvitation(other, x);
    accounts.set(x, { email: 'x@test.local', user_metadata: { invite_id: a } });
    await fixture.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING", [other, me]);
    expect(await revoke(a, x)).toEqual([]); // B still waits on it
    expect(await revoke(b, x, other)).toEqual([`/admin/users/${x}`]); // stamped by A's invitation: still a placeholder
  });

  it('round 2 REPRO 6: an EXPIRED invitation pinned to it is not a hold', async () => {
    const x = crypto.randomUUID();
    const a = await pendingInvitation(company, x);
    await pendingInvitation(other, x, { expired: true });
    accounts.set(x, { email: 'x@test.local', user_metadata: { invite_id: a } });
    expect(await revoke(a, x)).toEqual([`/admin/users/${x}`]);
  });

  it('round 2 REPRO 7: another company pins it while revoke reads GoTrue: re-counted before the delete, kept', async () => {
    const x = crypto.randomUUID();
    const a = await pendingInvitation(company, x);
    accounts.set(x, { email: 'x@test.local', user_metadata: { invite_id: a } });
    let theirs = '';
    onGet.fn = async () => { theirs = await pendingInvitation(other, x); };
    expect(await revoke(a, x)).toEqual([]);
    expect((await fixture.query('SELECT gotrue_user_id FROM company_invitations WHERE id = $1', [theirs])).rows)
      .toEqual([{ gotrue_user_id: x }]);
  });
});
