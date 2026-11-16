/**
 * The pending invitations an admin's deleteUser cancels (follow-up A, Hein 2026-11-16: the deleted person's GoTrue
 * sign-in stays, so an invitation still pending for them must not let them back in).
 *
 * Re-entry needs the GoTrue account: POST /api/invite/<token> compares the invitation to the session user's CURRENT
 * GoTrue login email, and POST /api/invitations/<token>/accept signs in as the invitation's address (only the GoTrue
 * holder of that address can) or through the account pinned on it (gotrue_user_id). users.email and GoTrue drift (a
 * POPIA erasure rewrites users.email and leaves GoTrue alone; change-email's documented partial failures), breaker
 * #1468. So for a row that owns a GoTrue account the cancel takes the invitations pinned to it and those addressed to
 * its GoTrue login email, never the row's email: a stale users.email may be another person's GoTrue address now, and
 * their invitations are not this delete's (round-5 breaker R5-2). A row that owns none is cancelled by its own email.
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

/** The GoTrue account a users row owns: its login email, null when it has none (GoTrue's '' for a phone-only account). */
export interface OwnedGotrueAccount {
  email: string | null;
}

/**
 * The GoTrue account `userId` owns (above), or null when it owns none: a non-canonical id, or GoTrue's 404. Any other
 * failure throws (an outage is AuthUpstreamUnavailableError), so the delete fails closed as a 5xx that writes nothing,
 * never a partial cancel. deleteUser calls it BEFORE any row lock: no lock is held across the HTTP call.
 */
export async function ownedGotrueAccount(userId: string): Promise<OwnedGotrueAccount | null> {
  if (!ownsGotrueAccount(userId)) return null;
  const account = await adminGetUser(userId);
  return account === null ? null : { email: account.email || null };
}

/**
 * Deletes every invitation still pending (expired included) that could let the deleted row back in; returns how many.
 * With a GoTrue account: those pinned to it (997b runs that arm only for a canonical lower-case id, the rule above) and
 * those addressed to its login email. Without one: those addressed to the deleted row's email. Addresses compare
 * trimmed (JavaScript trim's whitespace set, as the legacy accept compares) and lower-cased. Accepted invitations stay.
 * Call LAST in the delete's own transaction, after `DELETE FROM users` (997b's definer refuses while the users row
 * exists): the invitation rows are the last lock of every writer of a user's rows, as both accept routes take them.
 */
export async function cancelPendingInvitations(
  userId: string, rowEmail: string | null, account: OwnedGotrueAccount | null,
): Promise<number> {
  const address = account === null ? rowEmail : account.email;
  const addresses = typeof address === 'string' && address.trim() !== '' ? [address] : [];
  const rows = await sql<{ n: number }>`SELECT public.admin_cancel_user_invitations(${userId}, ${addresses}::text[]) AS n`;
  return Number(rows[0]?.n ?? 0);
}
