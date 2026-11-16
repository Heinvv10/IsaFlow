/**
 * F1 + F2 (2026-11-16, closes R7-1): a Settings -> User Access invitation (createInvitation) pins the GoTrue account
 * that holds the address when it is sent, as POST /api/invitations does, and a re-invite takes the new lookup's pin
 * (or NULL), never the old row's. Both accept routes then accept only as the pinned account.
 *
 * R7-1 decision: a deleted user's GoTrue account survives (decision 2a), so a Settings re-invite of their address
 * pins THAT account and they rejoin as the same identity; an account that takes the address between the invite
 * and the accept is refused on both routes, never made a new identity. An address no account holds is unpinned:
 * the accept creates that address's own account (the admin invited the address; a fresh invitation lets them in).
 *
 * Real routes on the disposable schema fixture; GoTrue is the fetch stub in admin-delete-user-invitations.helpers
 * (no network), and no email is sent (createInvitation mails nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '@/modules/accounting/services/core/userInvitationService';
import { AuthUpstreamUnavailableError } from '@/lib/auth/authUpstream';
import {
  adminDelete, companies, gotrueDown, invite, inviter, legacyAccept, memberships, newAccept, passwordSets, pool,
  resetAdminLimit, seedUser, setGotrueEmail, setup, teardown, trackToken, usersRows,
} from './admin-delete-user-invitations.helpers';

const [A, B, C, D] = companies;
/** GoTrue-only accounts this file makes (no users row unless an accept writes one): removed before teardown. */
const strangers: string[] = [];

beforeAll(setup, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [strangers]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [strangers]);
  await teardown();
});

const pinOf = async (company: string, email: string) => ((await pool.query(
  'SELECT gotrue_user_id FROM company_invitations WHERE company_id = $1 AND email = $2', [company, email],
)).rows[0] as { gotrue_user_id: string | null } | undefined)?.gotrue_user_id;
const memberOf = async (company: string, id: string) => (await pool.query(
  'SELECT count(*)::int n FROM company_users WHERE company_id = $1 AND lower(user_id) = lower($2)', [company, id])).rows[0].n as number;

/** Settings invite; returns the raw token (as mailed). */
async function settingsInvite(company: string, email: string): Promise<string> {
  const r = await createInvitation(company, email, 'viewer', inviter);
  trackToken(r.invitation.token);
  return r.invitation.token;
}

/** `u` moves to another address in GoTrue (and users.email), and a new GoTrue-only account takes `u.email`. */
function addressChangesHands(u: { id: string; email: string }): Promise<string> {
  const moved = `moved-${u.id}@test.local`;
  setGotrueEmail(u.id, moved);
  const stranger = crypto.randomUUID();
  strangers.push(stranger);
  setGotrueEmail(stranger, u.email);
  return pool.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, moved]).then(() => stranger);
}

describe('createInvitation pins the GoTrue account holding the address (F1)', () => {
  it('an address with an account: pinned to it; a different identity holding it at accept is refused on both routes', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await settingsInvite(B, u.email);
    expect(await pinOf(B, u.email)).toBe(u.id);

    const stranger = await addressChangesHands(u);
    const legacy = await legacyAccept(stranger, token);
    expect([legacy.status, legacy.body.error?.message]).toEqual([403, 'This invitation was sent to a different account']);
    const anon = await newAccept(token);
    expect([anon.status, anon.body.error?.code]).toEqual([409, 'IDENTITY_MISMATCH']);
    expect(await memberOf(B, stranger)).toBe(0);
    expect(await usersRows(stranger)).toBe(0);
    expect(passwordSets).not.toContain(stranger);
  });

  it('an address no account holds: NULL, and the accept creates that address its own account', async () => {
    const email = `nobody-${crypto.randomUUID()}@test.local`;
    const token = await settingsInvite(B, email);
    expect(await pinOf(B, email)).toBeNull();
    const r = await newAccept(token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = (r.body as { data?: { userId?: string } }).data!.userId!;
    strangers.push(id);
    expect(await memberOf(B, id)).toBe(1);
    expect(passwordSets).toContain(id); // created for this invitation (invite_id): its password is the invitee's
  });

  it('GoTrue cannot answer the lookup: AuthUpstreamUnavailableError, no invitation written', async () => {
    const email = `down-${crypto.randomUUID()}@test.local`;
    gotrueDown.add(email);
    try {
      await expect(createInvitation(B, email, 'viewer', inviter)).rejects.toBeInstanceOf(AuthUpstreamUnavailableError);
    } finally { gotrueDown.delete(email); }
    expect(await pinOf(B, email)).toBeUndefined();
  });
});

// Security review of F1: a Settings pin names an account that already held the address. The password accept never
// sets a password on it (it signs in with its own), and refuses it once its login email is no longer the invitation's.
describe('the password accept on a Settings-pinned existing account', () => {
  it('a pinned account with no users row (a deleted user\'s login): joins by its own password, none written', async () => {
    const u = await seedUser({ memberOf: [A] });
    await resetAdminLimit();
    expect((await adminDelete(u.id)).status).toBe(200); // not established any more: no users row
    const token = await settingsInvite(B, u.email);
    expect(await pinOf(B, u.email)).toBe(u.id);
    const r = await newAccept(token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await memberOf(B, u.id)).toBe(1);
    expect(passwordSets).not.toContain(u.id);
  });

  it("the pinned account's login email moved since the invite: 409 IDENTITY_MISMATCH, no password written", async () => {
    const u = await seedUser({ memberOf: [A] });
    await resetAdminLimit();
    expect((await adminDelete(u.id)).status).toBe(200);
    const token = await settingsInvite(B, u.email);
    setGotrueEmail(u.id, `moved-${u.id}@test.local`);
    const r = await newAccept(token);
    expect([r.status, r.body.error?.code]).toEqual([409, 'IDENTITY_MISMATCH']);
    expect(passwordSets).not.toContain(u.id);
    expect(await memberOf(B, u.id)).toBe(0);
  });
});

// #1517 breaker B4: an unconfirmed signup or squatter (never confirmed, never signed in, no users row) at the address
// does not block the invitee: the link proves the mailbox, and the account holds nothing.
describe('the password accept on a pinned unconfirmed account', () => {
  it('pinned to a never-confirmed, never-signed-in account: the invitee sets its password and joins as it', async () => {
    const email = `squat-${crypto.randomUUID()}@test.local`;
    const squatter = crypto.randomUUID();
    strangers.push(squatter);
    setGotrueEmail(squatter, email); // a GoTrue account only: unconfirmed, never signed in
    const token = await settingsInvite(B, email);
    expect(await pinOf(B, email)).toBe(squatter);
    const r = await newAccept(token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(passwordSets).toContain(squatter);
    expect(await memberOf(B, squatter)).toBe(1);
  });
});

describe('a re-invite replaces the pin (F2)', () => {
  it('a stale pin on the earlier row is replaced by the account holding the address now', async () => {
    const u = await seedUser();
    const stale = crypto.randomUUID();
    await invite(C, u.email, { gotrueUserId: stale, acceptedAt: '2026-11-01T00:00:00Z' });
    await settingsInvite(C, u.email);
    expect(await pinOf(C, u.email)).toBe(u.id);
  });

  it('a stale pin is nulled when no account holds the address now', async () => {
    const email = `gone-${crypto.randomUUID()}@test.local`;
    await invite(C, email, { gotrueUserId: crypto.randomUUID() });
    await settingsInvite(C, email);
    expect(await pinOf(C, email)).toBeNull();
  });
});

describe('R7-1 end to end: admin delete, Settings re-invite of the address, accept', () => {
  it('R7-1: the deleted user rejoins as their original GoTrue identity (pinned), never a new one', async () => {
    const u = await seedUser({ memberOf: [D] });
    await resetAdminLimit();
    expect((await adminDelete(u.id)).status).toBe(200);
    expect(await usersRows(u.id)).toBe(0);

    const token = await settingsInvite(D, u.email);
    expect(await pinOf(D, u.email)).toBe(u.id);
    const r = await legacyAccept(u.id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await memberOf(D, u.id)).toBe(1);
    expect(await usersRows(u.id)).toBe(1);
  });

  it('R7-1: the address passes to another account before the accept: refused on both routes, no new identity', async () => {
    const u = await seedUser({ memberOf: [D] });
    await resetAdminLimit();
    expect((await adminDelete(u.id)).status).toBe(200);
    const token = await settingsInvite(D, u.email);
    expect(await pinOf(D, u.email)).toBe(u.id);

    const stranger = crypto.randomUUID();
    strangers.push(stranger);
    setGotrueEmail(u.id, `moved-${u.id}@test.local`);
    setGotrueEmail(stranger, u.email);
    expect((await legacyAccept(stranger, token)).status).toBe(403);
    expect((await newAccept(token)).body.error?.code).toBe('IDENTITY_MISMATCH');
    expect(await memberOf(D, stranger)).toBe(0);
    expect(await memberships(u.id)).toBe(0);
    expect(passwordSets).not.toContain(stranger);
    expect(passwordSets).not.toContain(u.id);
  });
});
