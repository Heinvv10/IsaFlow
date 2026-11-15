/**
 * Follow-up A (2026-11-16, decision 2a.1): deleting a user cancels every invitation still pending for their address,
 * in the delete's own transaction. Their GoTrue sign-in is NOT banned, so before this the deleted person signed in
 * and accepted an old invitation, and either accept route re-created their users row and a membership.
 *   - delete, then the old invitation on POST /api/invite/<token>: its not-found answer, nothing written;
 *   - delete, then the old invitation on POST /api/invitations/<token>/accept: its 410, nothing written, and the
 *     GoTrue password is never set;
 *   - every pending invitation to the address goes, in any company, letter case or spacing (lower(btrim())), expired
 *     ones too; an accepted invitation and another address's stay; `user.delete`'s audit row counts what went;
 *   - a fresh invitation after the delete still lets the person back in, through either route.
 * The delete-vs-accept races are in admin-delete-user-invitations-race.int.test.ts. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInvitation } from '@/modules/accounting/services/core/userInvitationService';
import {
  adminDelete, companies, deleteAudit, invitationRow, invite, inviter, legacyAccept, memberships, newAccept,
  passwordSets, pendingFor, pool, resetAdminLimit, seedUser, setup, teardown, trackToken, usersRows,
} from './admin-delete-user-invitations.helpers';

const [A, B, C, D] = companies;

beforeAll(setup, 60000);
beforeEach(resetAdminLimit);
afterAll(teardown);

describe('deleting a user cancels their pending invitations', () => {
  it('delete, then the old invitation on POST /api/invite/<token>: not found, and nothing is written', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email, { gotrueUserId: u.id });
    const del = await adminDelete(u.id);
    expect(del.status, JSON.stringify(del.body)).toBe(200);

    const r = await legacyAccept(u.id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(await usersRows(u.id)).toBe(0);
    expect(await memberships(u.id)).toBe(0);
    expect(await invitationRow(token)).toBeUndefined();
  });

  it('delete, then the old invitation on POST /api/invitations/<token>/accept: 410, nothing written, no password set', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email, { gotrueUserId: u.id });
    const del = await adminDelete(u.id);
    expect(del.status, JSON.stringify(del.body)).toBe(200);

    const r = await newAccept(token);
    expect(r.status, JSON.stringify(r.body)).toBe(410);
    expect(r.body.error?.code).toBe('INVALID_OR_EXPIRED');
    expect(await usersRows(u.id)).toBe(0);
    expect(await memberships(u.id)).toBe(0);
    expect(passwordSets).not.toContain(u.id);
    expect(await invitationRow(token)).toBeUndefined();
  });

  it('every pending invitation to the address goes (any company, case, spacing, expired); others stay; audited', async () => {
    const id = crypto.randomUUID();
    const u = await seedUser({ memberOf: [A], email: `Mixed.${id}@Test.Local` });
    await invite(A, `mixed.${id}@test.local`);
    await invite(B, `  MIXED.${id.toUpperCase()}@TEST.LOCAL `);
    await invite(C, u.email, { gotrueUserId: u.id });
    await invite(D, `MIXED.${id}@test.local`, { expired: true });
    const accepted = await invite(D, u.email, { acceptedAt: '2026-11-01T00:00:00Z' });
    const otherAddress = await invite(A, `not-mixed.${id}@test.local`);
    const lookalike = await invite(B, `mixed.${id}@test.local.example`);

    const del = await adminDelete(u.id);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(await pendingFor(u.email)).toBe(0);
    expect((await invitationRow(accepted))?.accepted_at).not.toBeNull();
    expect(await invitationRow(otherAddress)).toEqual({ accepted_at: null });
    expect(await invitationRow(lookalike)).toEqual({ accepted_at: null });
    expect(await deleteAudit(u.id)).toEqual([expect.objectContaining({ invitations_cancelled: 4 })]);
  });

  it('a user with no pending invitation: deleted as before, the audit row says 0 were cancelled', async () => {
    const u = await seedUser({ memberOf: [A] });
    const del = await adminDelete(u.id);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(await usersRows(u.id)).toBe(0);
    expect(await deleteAudit(u.id)).toEqual([expect.objectContaining({ invitations_cancelled: 0 })]);
  });

  it('a delete refused for a sole owner cancels nothing', async () => {
    const u = await seedUser();
    const solo = crypto.randomUUID();
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [solo, 'delinv solo']);
    try {
      await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [solo, u.id]);
      const token = await invite(B, u.email, { gotrueUserId: u.id });
      const del = await adminDelete(u.id);
      expect(del.status, JSON.stringify(del.body)).toBe(409);
      expect(await invitationRow(token)).toEqual({ accepted_at: null });
      expect(await usersRows(u.id)).toBe(1);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [solo]);
      await pool.query('DELETE FROM companies WHERE id = $1', [solo]);
    }
  });

  it('a fresh invitation after the delete lets them back in, through either route', async () => {
    // Legacy route: re-invited to the company they were in (createInvitation refreshes the accepted row in place).
    const u1 = await seedUser({ memberOf: [A] });
    await invite(A, u1.email, { acceptedAt: '2026-11-01T00:00:00Z' });
    await invite(B, u1.email, { gotrueUserId: u1.id });
    expect((await adminDelete(u1.id)).status).toBe(200);
    const again = await createInvitation(A, u1.email, 'viewer', inviter);
    trackToken(again.invitation.token);
    const r1 = await legacyAccept(u1.id, again.invitation.token);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(await usersRows(u1.id)).toBe(1);
    expect((await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [A, u1.id])).rows)
      .toEqual([{ role: 'viewer' }]);

    // New route: a brand-new invitation; POST /api/invitations stamps the GoTrue user on it.
    const u2 = await seedUser({ memberOf: [A] });
    await invite(B, u2.email, { gotrueUserId: u2.id });
    expect((await adminDelete(u2.id)).status).toBe(200);
    const fresh = await createInvitation(C, u2.email, 'viewer', inviter);
    trackToken(fresh.invitation.token);
    await pool.query('UPDATE company_invitations SET gotrue_user_id = $1 WHERE id = $2', [u2.id, fresh.invitation.id]);
    const r2 = await newAccept(fresh.invitation.token);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(await usersRows(u2.id)).toBe(1);
    expect((await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [C, u2.id])).rows)
      .toEqual([{ role: 'viewer' }]);
  });
});
