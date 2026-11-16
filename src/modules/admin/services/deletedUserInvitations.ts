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
 * Which users row owns a GoTrue account: a canonical lower-case UUID id owns the account with that id, and any other
 * spelling owns none. GoTrue ids are lower-case UUIDs and every session resolves its sub to the users row with exactly
 * that id (withUserAuth, companyMembership), so an upper-case or otherwise non-canonical row (legacy, hand-seeded, a
 * case variant) is never the row a GoTrue sign-in reaches. GoTrue itself parses the id in any case, so asking it about
 * a variant would answer with the canonical row's account: someone else's (round-4 review HIGH).
 */
const ownsGotrueAccount = (userId: string): boolean => userId === userId.toLowerCase() && UUID_RE.test(userId);

/**
 * The login email of the GoTrue account `userId` owns (above), or null: a row that owns none, GoTrue's 404, or an
 * account with no email (GoTrue answers '' for a phone-only account). Any other failure throws (an outage is
 * AuthUpstreamUnavailableError), so the delete fails closed as a 5xx that writes nothing, never a partial cancel.
 * deleteUser calls it BEFORE any row lock: no lock is held across the HTTP call.
 */
export async function gotrueLoginEmail(userId: string): Promise<string | null> {
  if (!ownsGotrueAccount(userId)) return null;
  const account = await adminGetUser(userId);
  return account?.email || null;
}

/**
 * Deletes every invitation still pending (expired included) pinned to the GoTrue account the deleted row owned (997b
 * runs that arm only for a canonical lower-case id, the same rule as above) or addressed, trimmed (JavaScript trim's
 * whitespace set, as the legacy accept compares) and lower-cased, to the deleted row's email or the GoTrue login email;
 * returns how many. Accepted invitations stay. Call LAST in the delete's own transaction, after `DELETE FROM users`
 * (997b's definer refuses while the users row exists): the invitation rows are the last lock of every writer of a
 * user's rows, as both accept routes take them.
 */
export async function cancelPendingInvitations(
  userId: string, rowEmail: string | null, gotrueEmail: string | null,
): Promise<number> {
  const addresses = [...new Set([rowEmail, gotrueEmail].filter((e): e is string => typeof e === 'string' && e.trim() !== ''))];
  const rows = await sql<{ n: number }>`SELECT public.admin_cancel_user_invitations(${userId}, ${addresses}::text[]) AS n`;
  return Number(rows[0]?.n ?? 0);
}
