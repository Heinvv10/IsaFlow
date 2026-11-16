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
 * The GoTrue account's login email, or null when there is none: an id that is not a canonical lower-case UUID (GoTrue
 * ids are lower-case UUIDs; any other spelling is a legacy, hand-seeded or case-variant profile, and GoTrue, which
 * parses the id, would answer with the account of the lower-case spelling: someone else's row; round-4 review HIGH),
 * GoTrue's 404, or an account with no email (GoTrue answers '' for a phone-only account). Any other failure throws
 * (an outage is AuthUpstreamUnavailableError), so the delete fails closed as a 5xx that writes nothing, never a
 * partial cancel. deleteUser calls it BEFORE any row lock: no lock is held across the HTTP call.
 */
export async function gotrueLoginEmail(userId: string): Promise<string | null> {
  if (userId !== userId.toLowerCase() || !UUID_RE.test(userId)) return null;
  const account = await adminGetUser(userId);
  return account?.email || null;
}

/**
 * Deletes every invitation still pending (expired included) pinned to `userId`'s GoTrue account or addressed,
 * trimmed (JavaScript trim's whitespace set, as the legacy accept compares) and lower-cased, to the deleted row's email
 * or the GoTrue login email; returns how many. Accepted invitations stay.
 * Call LAST in the delete's own transaction, after `DELETE FROM users` (migration 997b's definer refuses while the
 * users row exists): the invitation rows are the last lock of every writer of a user's rows, as both accept routes
 * take them.
 *
 * When a users row naming the same id in another letter case survives the delete (two stored rows, one GoTrue
 * account: admin .claude.md, "users rows are different"), the GoTrue account and its login email are that live
 * user's, so the GoTrue email is not used (round-4 review HIGH) and 997b's pinned arm is off as well.
 */
export async function cancelPendingInvitations(
  userId: string, rowEmail: string | null, gotrueEmail: string | null,
): Promise<number> {
  const survivor = gotrueEmail === null ? []
    : await sql`SELECT 1 FROM users WHERE lower(id) = lower(${userId}) LIMIT 1`;
  const emails = survivor.length > 0 ? [rowEmail] : [rowEmail, gotrueEmail];
  const addresses = [...new Set(emails.filter((e): e is string => typeof e === 'string' && e.trim() !== ''))];
  const rows = await sql<{ n: number }>`SELECT public.admin_cancel_user_invitations(${userId}, ${addresses}::text[]) AS n`;
  return Number(rows[0]?.n ?? 0);
}
