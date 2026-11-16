/**
 * Follow-up A (2026-11-16): POST /api/invite/<token> stopped locking the invitation first (it now marks it accepted
 * last, still pending under its token, or rolls back). Every other answer must be what it was: pinned here, exact
 * status and body, for success, an expired invitation, an already-used one, an unknown token and a session whose
 * email is not the invitation's; each refusal writes nothing.
 * Re-break of #1468 (F1): the session's email claim is stale for up to an hour after change-email (no token is
 * re-issued), so the route compares the invitation to GoTrue's CURRENT login email for the session's user, read
 * before its transaction: an old-address invitation the delete could not know of is refused; no GoTrue account is
 * the same 403; GoTrue unable to answer is a 5xx that writes nothing. Disposable fixture only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminDelete, companies, deleteAudit, gotrueDown, invitationRow, invite, legacyAccept, memberships, pool, resetAdminLimit,
  seedUser, setGotrueEmail, setup, teardown, usersRows,
} from './admin-delete-user-invitations.helpers';

const [A, B, C] = companies;
const NOT_FOUND = { success: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } };

beforeAll(setup, 60000);
afterAll(teardown);

/** The body without its envelope's timestamp-like extras: what a client reads. */
const shape = (body: unknown) => {
  const b = body as { success?: boolean; data?: unknown; message?: string; error?: { code?: string; message?: string } };
  return b.success ? { success: true, data: b.data, message: b.message }
    : { success: false, error: { code: b.error?.code, message: b.error?.message } };
};

describe('POST /api/invite/<token> answers as before', () => {
  it('success: 200 with the company, the membership at the invited role, the invitation accepted', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email, { role: 'manager' });
    const r = await legacyAccept(u.id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(shape(r.body)).toEqual({ success: true, data: { companyId: B }, message: 'Invitation accepted' });
    expect((await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [B, u.id])).rows)
      .toEqual([{ role: 'manager' }]);
    expect(await invitationRow(token)).toEqual({ accepted_at: expect.any(Date) });
  });

  it('an expired invitation: 404 Invitation not found, nothing written', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email, { expired: true });
    const r = await legacyAccept(u.id, token);
    expect([r.status, shape(r.body)]).toEqual([404, NOT_FOUND]);
    expect(await memberships(u.id)).toBe(1);
    expect(await invitationRow(token)).toEqual({ accepted_at: null });
  });

  it('an invitation already used: 404 Invitation not found, nothing written', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email);
    expect((await legacyAccept(u.id, token)).status).toBe(200);
    const before = await invitationRow(token);
    const again = await legacyAccept(u.id, token);
    expect([again.status, shape(again.body)]).toEqual([404, NOT_FOUND]);
    expect(await invitationRow(token)).toEqual(before);
    expect(await memberships(u.id)).toBe(2);
  });

  it('an unknown token: 404 Invitation not found', async () => {
    const u = await seedUser({ memberOf: [A] });
    const r = await legacyAccept(u.id, `delinv-unknown-${crypto.randomUUID()}`);
    expect([r.status, shape(r.body)]).toEqual([404, NOT_FOUND]);
  });

  it("a session whose email is not the invitation's: 403, nothing written", async () => {
    const [u, other] = [await seedUser({ memberOf: [A] }), await seedUser()];
    const token = await invite(B, u.email);
    const r = await legacyAccept(other.id, token);
    expect([r.status, shape(r.body)]).toEqual([403, {
      success: false, error: { code: 'FORBIDDEN', message: 'This invitation was sent to a different email address' },
    }]);
    expect(await memberships(other.id)).toBe(0);
    expect(await invitationRow(token)).toEqual({ accepted_at: null });
  });
});

describe("POST /api/invite/<token> judges GoTrue's current login email, not the session's claim", () => {
  const MISMATCH = { success: false, error: { code: 'FORBIDDEN', message: 'This invitation was sent to a different email address' } };

  it('changed email, then deleted: a session still carrying the old address cannot use an old-address invitation', async () => {
    const u = await seedUser({ memberOf: [A] });
    const oldAddress = await invite(B, u.email); // Settings -> User Access: no GoTrue user pinned
    const moved = `moved-${u.id}@test.local`;
    await pool.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, moved]);
    setGotrueEmail(u.id, moved);
    await resetAdminLimit();
    expect((await adminDelete(u.id)).status).toBe(200);
    expect(await deleteAudit(u.id)).toEqual([expect.objectContaining({ invitations_cancelled: 0 })]); // it knew only `moved`

    const r = await legacyAccept(u.id, oldAddress); // signSession's claim: the OLD `<id>@test.local`
    expect([r.status, shape(r.body)]).toEqual([403, MISMATCH]);
    expect(await usersRows(u.id)).toBe(0);
    expect(await memberships(u.id)).toBe(0);
    expect(await invitationRow(oldAddress)).toEqual({ accepted_at: null });
  });

  it('a live user whose claim is stale: the same 403, nothing written; their current address still accepts', async () => {
    const u = await seedUser({ memberOf: [A] });
    const oldAddress = await invite(B, u.email);
    const moved = `moved-${u.id}@test.local`;
    setGotrueEmail(u.id, moved);
    const r = await legacyAccept(u.id, oldAddress);
    expect([r.status, shape(r.body)]).toEqual([403, MISMATCH]);
    expect(await memberOf(B, u.id)).toBe(0);
    const current = await invite(B, moved.toUpperCase());
    expect((await legacyAccept(u.id, current)).status).toBe(200);
  });

  it('no GoTrue account for the session: the same 403, nothing written', async () => {
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@test.local`]);
    const token = await invite(B, `${id}@test.local`);
    const r = await legacyAccept(id, token);
    expect([r.status, shape(r.body)]).toEqual([403, MISMATCH]);
    expect(await memberOf(B, id)).toBe(0);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  });

  it('GoTrue cannot answer, but the token names no live invitation: the 404, before any GoTrue call', async () => {
    const u = await seedUser({ memberOf: [A] });
    const used = await invite(B, u.email, { acceptedAt: '2026-11-01T00:00:00Z' });
    gotrueDown.add(u.id);
    try {
      for (const token of [`delinv-unknown-${crypto.randomUUID()}`, used, await invite(C, u.email, { expired: true })]) {
        const r = await legacyAccept(u.id, token);
        expect([r.status, shape(r.body)]).toEqual([404, { success: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } }]);
      }
    } finally { gotrueDown.delete(u.id); }
  });

  it('GoTrue cannot answer: a 5xx, nothing written', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email);
    gotrueDown.add(u.id);
    try {
      const r = await legacyAccept(u.id, token);
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(500);
    } finally { gotrueDown.delete(u.id); }
    expect(await memberOf(B, u.id)).toBe(0);
    expect(await invitationRow(token)).toEqual({ accepted_at: null });
  });
});

const memberOf = async (company: string, userId: string) => (await pool.query(
  'SELECT count(*)::int n FROM company_users WHERE company_id = $1 AND user_id = $2', [company, userId])).rows[0].n as number;
