/**
 * Follow-up A (2026-11-16): POST /api/invite/<token> stopped locking the invitation first (it now marks it accepted
 * last, still pending under its token, or rolls back). Every other answer must be what it was: pinned here, exact
 * status and body, for success, an expired invitation, an already-used one, an unknown token and a session whose
 * email is not the invitation's; each refusal writes nothing. Disposable fixture only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  companies, invitationRow, invite, legacyAccept, memberships, pool, seedUser, setup, teardown,
} from './admin-delete-user-invitations.helpers';

const [A, B] = companies;
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
