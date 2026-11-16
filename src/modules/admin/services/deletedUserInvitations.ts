/**
 * The pending invitations an admin's deleteUser cancels (follow-up A, Hein 2026-11-16: the deleted person's GoTrue
 * sign-in stays, so an invitation still pending for them must not let them back in).
 *
 * The accept routes match the GoTrue identity, not users.email: POST /api/invite/<token> compares the session's
 * (GoTrue) email, and POST /api/invitations/<token>/accept signs in through the GoTrue account pinned on the
 * invitation (gotrue_user_id) or its address. users.email and GoTrue drift (a POPIA erasure rewrites users.email and
 * leaves GoTrue alone; change-email's documented partial failures), breaker #1468. So the cancel takes every pending
 * invitation pinned to the user's id, or addressed to the deleted row's email, or to the GoTrue login email.
 */
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { adminGetUser } from '@/lib/auth/gotrueAdminUser';

/**
 * The GoTrue account's login email, or null when there is none: an id that is no UUID (GoTrue ids are UUIDs; such a
 * profile is legacy or hand-seeded and has no GoTrue account) or GoTrue's 404. Any other failure throws (an outage is
 * AuthUpstreamUnavailableError), so the delete fails closed as a 5xx that writes nothing, never a partial cancel.
 * deleteUser calls it BEFORE any row lock: no lock is held across the HTTP call.
 */
export async function gotrueLoginEmail(userId: string): Promise<string | null> {
  if (!UUID_RE.test(userId)) return null;
  const account = await adminGetUser(userId);
  return account?.email ?? null;
}

/**
 * Deletes every invitation still pending (expired included) pinned to `userId`'s GoTrue account or addressed, as
 * lower(btrim()), to one of `emails`; returns how many. Accepted invitations stay. Call LAST in the delete's own
 * transaction, after `DELETE FROM users` (migration 997b's definer refuses while the users row exists): the
 * invitation rows are the last lock of every writer of a user's rows, as both accept routes take them.
 */
export async function cancelPendingInvitations(userId: string, emails: ReadonlyArray<string | null>): Promise<number> {
  const addresses = [...new Set(emails.filter((e): e is string => typeof e === 'string' && e.trim() !== ''))];
  const rows = await sql<{ n: number }>`SELECT public.admin_cancel_user_invitations(${userId}, ${addresses}::text[]) AS n`;
  return Number(rows[0]?.n ?? 0);
}
