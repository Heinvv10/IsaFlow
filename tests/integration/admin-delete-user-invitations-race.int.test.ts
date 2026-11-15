/**
 * Follow-up A (2026-11-16): an admin's DELETE of a user racing that user's accept of a pending invitation, on each
 * accept route, never deadlocks (40P01, a 500) and always ends consistent:
 *   - the delete went first: the accept is refused (404 / 410), the invitation is gone, nothing of the user is left;
 *   - the accept went first: it committed whole (invitation accepted), and the delete then removed the user and
 *     every membership, the new one included.
 * Never: a users row or membership of the deleted user, or a pending invitation left for their address.
 *
 * Barrier as in admin-user-lock-order.int.test.ts: each request is held right AFTER its first row-lock statement on
 * a user's rows or an invitation until the other has taken its own (or 1.5 s pass). One lock order serialises the
 * pair; two orders both take their first lock and then deadlock. Two shapes each: the invitation is to a company the
 * user is not in (the accept INSERTs a membership) and to one they are in (it locks the existing membership row).
 * Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminDelete, companies, deleteAudit, invitationRow, invite, legacyAccept, memberships, newAccept,
  onMigrationAdminStatement, pendingFor, resetAdminLimit, seedUser, setup, teardown, usersRows, type Answer,
} from './admin-delete-user-invitations.helpers';

/** A row-lock statement on a user's rows or an invitation (what the barrier holds a request after). */
const LOCKING = /^(DELETE FROM|UPDATE|INSERT INTO)\s+(public\.)?(company_users|users|user_sessions|company_invitations)\b|\bFROM\s+(public\.)?(company_users|users|company_invitations)\b[\s\S]*\bFOR\s+(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b|\badmin_cancel_user_invitations\b/i;

const probe = vi.hoisted(() => ({
  barrier: null as null | { need: number; arrived: number; open: () => void; opened: Promise<void> },
}));
async function arrive(text: string) {
  const b = probe.barrier;
  if (!b || b.arrived >= b.need || !LOCKING.test(text.trim())) return;
  b.arrived += 1;
  if (b.arrived >= b.need) b.open();
  await Promise.race([b.opened, new Promise((resolve) => setTimeout(resolve, 1500))]);
  b.open(); // whoever times out releases the rest: the barrier holds each request once
}
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const result = await realSql(strings, ...values);
    await arrive(strings.join('?'));
    return result;
  }, realSql);
  return { ...real, sql };
});
function setBarrier() {
  let open = () => undefined as void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  probe.barrier = { need: 2, arrived: 0, open, opened };
}

const [HOME, OTHER] = companies;

beforeAll(async () => {
  await setup();
  onMigrationAdminStatement(arrive);
}, 60000);
beforeEach(async () => {
  probe.barrier = null;
  await resetAdminLimit();
});
afterAll(teardown);

/** The end state either order may leave, and nothing in between. */
async function expectConsistent(u: { id: string; email: string }, token: string, del: Answer, accept: Answer, refused: number) {
  expect([del.status, accept.status].filter((s) => s >= 500), JSON.stringify({ del: del.body, accept: accept.body })).toEqual([]);
  expect(del.status, JSON.stringify(del.body)).toBe(200);
  expect(await usersRows(u.id)).toBe(0);
  expect(await memberships(u.id)).toBe(0);
  expect(await pendingFor(u.email)).toBe(0);
  if (accept.status === 200) {
    expect(await invitationRow(token)).toEqual({ accepted_at: expect.any(Date) });
    expect(await deleteAudit(u.id)).toEqual([expect.objectContaining({ invitations_cancelled: 0 })]);
  } else {
    expect(accept.status, JSON.stringify(accept.body)).toBe(refused);
    expect(await invitationRow(token)).toBeUndefined();
    expect(await deleteAudit(u.id)).toEqual([expect.objectContaining({ invitations_cancelled: 1 })]);
  }
}

describe.each([
  ['POST /api/invite/<token>', 404, (u: { id: string }, token: string) => legacyAccept(u.id, token)],
  ['POST /api/invitations/<token>/accept', 410, (_u: { id: string }, token: string) => newAccept(token)],
] as const)('DELETE user racing %s', (_name, refused, accept) => {
  it.each([1, 2, 3])('an invitation to a company they are not in, run %i', async () => {
    const u = await seedUser({ memberOf: [HOME] });
    const token = await invite(OTHER, u.email, { gotrueUserId: u.id });
    setBarrier();
    const [del, acc] = await Promise.all([adminDelete(u.id), accept(u, token)]);
    await expectConsistent(u, token, del, acc, refused);
  }, 20000);

  it.each([1, 2, 3])('an invitation to the company they are in (a re-role), run %i', async () => {
    const u = await seedUser({ memberOf: [HOME] });
    const token = await invite(HOME, u.email, { gotrueUserId: u.id });
    setBarrier();
    const [del, acc] = await Promise.all([adminDelete(u.id), accept(u, token)]);
    await expectConsistent(u, token, del, acc, refused);
  }, 20000);
});
