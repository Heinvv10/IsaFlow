/**
 * Follow-up A, breaker #1468 (MEDIUM): the accept routes match the GoTrue identity, not users.email. The legacy route
 * compares the session's (GoTrue) email; the other signs in as the invitation's address, through the GoTrue account
 * pinned on it. users.email and GoTrue drift: a POPIA erasure rewrites users.email to `anonymized_…@deleted.invalid`
 * and leaves GoTrue alone; change-email can leave either side behind. So deleteUser cancels every pending invitation
 * pinned to the user's GoTrue id OR addressed to users.email OR to the GoTrue account's login email, which it reads
 * (GET /admin/users/<id>) before taking any row lock:
 *   - erased, then deleted: the old invitation is refused on both routes, nothing written;
 *   - change-email: an invitation to the OLD address pinned by gotrue_user_id goes, and so does one to the GoTrue
 *     address users.email never took (the partial failure);
 *   - GoTrue has no account (404): users.email alone, the delete goes ahead;
 *   - GoTrue cannot answer: the delete is a 5xx and writes nothing (never a partial cancel);
 *   - the definer refuses while the user's row still exists (it serves a delete, never a live user), and a case
 *     variant of a live id cannot reach that user's pinned invitations;
 *   - a canonical lower-case UUID id owns its GoTrue account, any other spelling owns none: deleting the upper-case
 *     variant of a live lower-case user leaves the live user's pinned AND addressed invitations (round-4 review HIGH),
 *     and deleting the lower-case row while an upper-case variant survives still cancels by its GoTrue id and login
 *     address (round-5 review MEDIUM).
 * GoTrue is the helpers' fetch stub. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminDelete, asRoleUrl, companies, deleteAudit, gotrueDown, invitationRow, invite, legacyAccept, memberships,
  newAccept, passwordSets, pool, resetAdminLimit, seedUser, setGotrueEmail, setup, teardown, usersRows,
} from './admin-delete-user-invitations.helpers';
import { Pool } from 'pg';

const [A, B, C, D] = companies;
beforeAll(setup, 60000);
beforeEach(resetAdminLimit);
afterAll(teardown);

/** pages/api/accounting/data-subject-rights.ts handleErasure's statement (GoTrue is not touched). */
const erase = (id: string) => pool.query(
  `UPDATE users SET first_name = 'Anonymized', last_name = $2, email = $3, updated_at = NOW() WHERE id = $1`,
  [id, `anonymized_${id}`, `anonymized_${id}@deleted.invalid`]);

describe('deleteUser cancels by the GoTrue identity too', () => {
  it('erased, then deleted: the old invitation on POST /api/invite/<token> is refused, nothing written', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email); // Settings -> User Access: no GoTrue user pinned
    await erase(u.id);
    expect((await adminDelete(u.id)).status).toBe(200);
    const r = await legacyAccept(u.id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(await usersRows(u.id)).toBe(0);
    expect(await memberships(u.id)).toBe(0);
    expect(await invitationRow(token)).toBeUndefined();
    expect(await deleteAudit(u.id)).toEqual([expect.objectContaining({ invitations_cancelled: 1 })]);
  });

  it('erased, then deleted: the old invitation on POST /api/invitations/<token>/accept is refused, no password set', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(C, u.email, { gotrueUserId: u.id });
    await erase(u.id);
    expect((await adminDelete(u.id)).status).toBe(200);
    const r = await newAccept(token);
    expect(r.status, JSON.stringify(r.body)).toBe(410);
    expect(await usersRows(u.id)).toBe(0);
    expect(await memberships(u.id)).toBe(0);
    expect(passwordSets).not.toContain(u.id);
  });

  it('change-email: the old address pinned by gotrue_user_id, and the GoTrue address users.email never took, both go', async () => {
    const u = await seedUser({ memberOf: [A] });
    const oldAddress = await invite(B, u.email, { gotrueUserId: u.id });
    const moved = `moved-${u.id}@test.local`;
    await pool.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, moved]); // change-email, both sides
    setGotrueEmail(u.id, moved);
    const v = await seedUser({ memberOf: [A] });
    const gotrueOnly = `gotrue-only-${v.id}@test.local`;
    setGotrueEmail(v.id, gotrueOnly); // GoTrue took it, the users COMMIT failed (change-email's logged drift)
    const toGotrueOnly = await invite(C, gotrueOnly);

    expect((await adminDelete(u.id)).status).toBe(200);
    expect(await invitationRow(oldAddress)).toBeUndefined();
    expect((await adminDelete(v.id)).status).toBe(200);
    expect(await invitationRow(toGotrueOnly)).toBeUndefined();
    expect(await deleteAudit(v.id)).toEqual([expect.objectContaining({ invitations_cancelled: 1 })]);
  });

  it('no GoTrue account (404): users.email alone, and the delete goes ahead', async () => {
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@test.local`]);
    const token = await invite(B, `${id}@test.local`);
    const del = await adminDelete(id);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(await invitationRow(token)).toBeUndefined();
  });

  it('GoTrue cannot answer: the delete is a 5xx and writes nothing', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email);
    gotrueDown.add(u.id);
    try {
      const del = await adminDelete(u.id);
      expect(del.status, JSON.stringify(del.body)).toBeGreaterThanOrEqual(500);
    } finally { gotrueDown.delete(u.id); }
    expect(await usersRows(u.id)).toBe(1);
    expect(await memberships(u.id)).toBe(1);
    expect(await invitationRow(token)).toEqual({ accepted_at: null });
    expect(await deleteAudit(u.id)).toEqual([]);
  });

  it('the definer refuses while the user still exists, and only platform_admin may call it', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email, { gotrueUserId: u.id });
    const asAdmin = new Pool({ connectionString: asRoleUrl('platform_admin'), max: 1 });
    const asApp = new Pool({ connectionString: asRoleUrl('app_user'), max: 1 });
    try {
      await expect(asAdmin.query('SELECT public.admin_cancel_user_invitations($1, $2)', [u.id, [u.email]]))
        .rejects.toMatchObject({ code: 'RC012' });
      // A case variant of a live id (re-break F2): no exact row, so no RC012, but the pinned arm (lower(p_user_id))
      // must not reach the live user's invitation either.
      expect((await asAdmin.query('SELECT public.admin_cancel_user_invitations($1, $2) AS n', [u.id.toUpperCase(), []]))
        .rows).toEqual([{ n: 0 }]);
      await expect(asApp.query('SELECT public.admin_cancel_user_invitations($1, $2)', [crypto.randomUUID(), [u.email]]))
        .rejects.toMatchObject({ code: '42501' });
    } finally { await Promise.all([asAdmin.end(), asApp.end()]); }
    expect(await invitationRow(token)).toEqual({ accepted_at: null });
  });
});

describe('a case-variant delete leaves the surviving user alone', () => {
  it("deleting UPPER(<live id>): the live user's pinned and addressed invitations both stay", async () => {
    const live = await seedUser({ memberOf: [A] });
    const pinned = await invite(B, live.email, { gotrueUserId: live.id });
    const addressed = await invite(C, live.email);
    const variant = live.id.toUpperCase();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`,
      [variant, `variant-${live.id}@test.local`]);
    try {
      const del = await adminDelete(variant);
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      expect((await pool.query('SELECT id FROM users WHERE lower(id) = lower($1)', [live.id])).rows).toEqual([{ id: live.id }]);
      expect({ pinned: await invitationRow(pinned), addressed: await invitationRow(addressed) })
        .toEqual({ pinned: { accepted_at: null }, addressed: { accepted_at: null } });
      expect(await deleteAudit(variant)).toEqual([expect.objectContaining({ invitations_cancelled: 0 })]);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [variant]);
    }
  });

  it('deleting the lower-case row while UPPER(<id>) survives: its GoTrue account is still the deleted one\'s', async () => {
    // Sessions resolve GoTrue's (lower-case) sub by exact id, so the account belongs to the canonical lower-case row;
    // an upper-case variant owns none (round-5 review MEDIUM). Its drifted login address must still be cancelled.
    const gone = await seedUser({ memberOf: [A] });
    const survivorId = gone.id.toUpperCase();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`,
      [survivorId, `survivor-${gone.id}@test.local`]);
    const drifted = `drifted-${gone.id}@test.local`; // held by no users row
    setGotrueEmail(gone.id, drifted);
    const pinned = await invite(B, `pinned-${gone.id}@test.local`, { gotrueUserId: gone.id });
    const addressed = await invite(C, drifted);
    try {
      const del = await adminDelete(gone.id);
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      expect({ pinned: await invitationRow(pinned), addressed: await invitationRow(addressed) })
        .toEqual({ pinned: undefined, addressed: undefined });
      const r = await legacyAccept(gone.id, addressed);
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      const anon = await newAccept(pinned); // the anonymous route, through the account pinned on the invitation
      expect(anon.status, JSON.stringify(anon.body)).toBe(410);
      expect(passwordSets).not.toContain(gone.id);
      expect(await usersRows(gone.id)).toBe(0);
      expect((await pool.query('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [gone.id])).rows[0].n).toBe(0);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [survivorId]);
    }
  });
});

describe("a GoTrue-backed user's stale users.email is not theirs to cancel", () => {
  it('the deleted row still holds X, but GoTrue moved it away and gave X to n: n\'s invitation to X stays', async () => {
    // Re-entry needs GoTrue's current email (the legacy route compares it; the anonymous route signs in as inv.email),
    // so for a canonical id with a GoTrue account only that email is cancelled, never the row's (round-5 breaker R5-2).
    const d = await seedUser({ memberOf: [A] });
    setGotrueEmail(d.id, `moved-${d.id}@test.local`);
    const n = await seedUser();
    setGotrueEmail(n.id, d.email);
    const forN = await invite(B, d.email);
    expect((await adminDelete(d.id)).status).toBe(200);
    expect(await invitationRow(forN)).toEqual({ accepted_at: null });
    expect(await deleteAudit(d.id)).toEqual([expect.objectContaining({ invitations_cancelled: 0 })]);
  });
});

describe('padding the accept route trims, the cancel trims too', () => {
  it.each([
    ['a tab', '\t'], ['a newline', '\n'], ['a no-break space', '\u00a0'], ['a byte-order mark', '\ufeff'],
  ])('an invitation stored with %s around the address is cancelled, and the legacy accept is refused', async (_label, pad) => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, `${pad}${u.email}${pad}`);
    expect((await adminDelete(u.id)).status).toBe(200);
    expect(await invitationRow(token)).toBeUndefined();
    const r = await legacyAccept(u.id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(await usersRows(u.id)).toBe(0);
    expect(await memberships(u.id)).toBe(0);
  });
});
