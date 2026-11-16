/**
 * Follow-up A, blind review of #1468: both accept routes read the invitation without a lock and mark it accepted
 * last. The mark must re-check everything the read checked, or a change in between is ignored:
 *   - a re-send (POST /api/invitations / createInvitation refresh the row in place with a new token): the OLD
 *     link must no longer accept;
 *   - the invitation expiring in between: no acceptance.
 * Each case changes the row right after the accept's membership upsert (its first statement in the transaction,
 * after the read) and checks the route gives its usual refusal and writes nothing. The legacy route has re-checked
 * token and expiry since this PR's lock move; /api/invitations/<token>/accept checked only `accepted_at IS NULL`.
 * Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import {
  companies, invitationRow, invite, legacyAccept, newAccept, onMigrationAdminStatement, pool, seedUser, setup, teardown,
} from './admin-delete-user-invitations.helpers';

const [A, B] = companies;
/** Runs once, right after the accept transaction's membership upsert returned. */
let between: null | (() => Promise<unknown>) = null;

beforeAll(async () => {
  await setup();
  onMigrationAdminStatement(async (text) => {
    if (!between || !/^\s*INSERT INTO company_users\b/i.test(text)) return;
    const run = between;
    between = null;
    await run();
  });
}, 60000);
beforeEach(() => { between = null; });
afterAll(teardown);

const memberOf = async (company: string, userId: string) => (await pool.query(
  'SELECT count(*)::int n FROM company_users WHERE company_id = $1 AND user_id = $2', [company, userId])).rows[0].n as number;

describe.each([
  ['POST /api/invite/<token>', 404, (u: { id: string }, token: string) => legacyAccept(u.id, token)],
  ['POST /api/invitations/<token>/accept', 410, (_u: { id: string }, token: string) => newAccept(token)],
] as const)('%s re-checks the invitation when it marks it accepted', (_name, refused, accept) => {
  it('re-sent between the read and the mark: the old link is refused, nothing written', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email, { gotrueUserId: u.id });
    const fresh = hashInviteToken(`delinv-resent-${crypto.randomUUID()}`);
    between = () => pool.query(
      `UPDATE company_invitations SET token = $2, expires_at = now() + interval '7 days', accepted_at = NULL
        WHERE token = $1`, [hashInviteToken(token), fresh]);
    const r = await accept(u, token);
    expect(between).toBeNull(); // the change ran inside the window
    expect(r.status, JSON.stringify(r.body)).toBe(refused);
    expect(await memberOf(B, u.id)).toBe(0);
    expect((await pool.query('SELECT accepted_at FROM company_invitations WHERE token = $1', [fresh])).rows)
      .toEqual([{ accepted_at: null }]);
  });

  it('expired between the read and the mark: refused, nothing written', async () => {
    const u = await seedUser({ memberOf: [A] });
    const token = await invite(B, u.email, { gotrueUserId: u.id });
    between = () => pool.query(`UPDATE company_invitations SET expires_at = now() - interval '1 second' WHERE token = $1`,
      [hashInviteToken(token)]);
    const r = await accept(u, token);
    expect(between).toBeNull();
    expect(r.status, JSON.stringify(r.body)).toBe(refused);
    expect(await memberOf(B, u.id)).toBe(0);
    expect(await invitationRow(token)).toEqual({ accepted_at: null });
  });
});
