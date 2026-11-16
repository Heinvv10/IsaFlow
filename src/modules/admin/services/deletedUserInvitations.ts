/**
 * The pending invitations an admin's deleteUser cancels (follow-up A, Hein 2026-11-16: the deleted person's GoTrue
 * sign-in stays, so an invitation still pending for them must not let them back in).
 *
 * Re-entry needs the GoTrue account: POST /api/invite/<token> compares the invitation to the session user's CURRENT
 * GoTrue login email, and POST /api/invitations/<token>/accept signs in as the invitation's address (only the GoTrue
 * holder of that address can) or through the account pinned on it (gotrue_user_id). users.email and GoTrue drift (a
 * POPIA erasure rewrites users.email and leaves GoTrue alone; change-email's documented partial failures), breaker
 * #1468. So the cancel takes the invitations pinned to the GoTrue account the row owns, those addressed to that
 * account's login email, and those addressed to the row's own email, EXCEPT when a DIFFERENT, ESTABLISHED GoTrue
 * account holds the row's email now: those invitations are that person's, not this delete's (round-5 breaker R5-2). A
 * placeholder holder (no users row, R6-1) does not count: the anonymous accept sets its password. Otherwise the row's
 * email stays in, account or not: a user who moved away from it in GoTrue may still read its mailbox, and the anonymous
 * route would mint a fresh identity for whoever holds the link (security review of 0700f0d6cf).
 */
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { adminGetUser } from '@/lib/auth/gotrueAdminUser';
import { findUserByEmail } from '@/lib/auth/gotrue';
import { isEstablishedAccount } from '@/lib/auth/inviteAccount';

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

/** The request transaction (`sql`, the admin portal's platform_admin connection) in the shape isEstablishedAccount reads. */
const requestDb = { query: async (text: string, params: unknown[]) => ({ rows: await sql.query(text, params) }) };

/** An address as both accept routes and 997b compare it: JavaScript trim, then lower case. */
const normalised = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase();

/** Who the deleted row is to GoTrue, read before any row lock (deleteUser). */
export interface DeletedUserIdentity {
  account: OwnedGotrueAccount | null;
  /** users.email as read before the delete's locks. */
  rowEmail: string;
  /** An ESTABLISHED GoTrue account (isEstablishedAccount) other than the one this row owns holds rowEmail now. */
  rowEmailHeldElsewhere: boolean;
}

/**
 * The GoTrue facts the cancel needs, read BEFORE any row lock (no lock is held across the HTTP calls): the account the
 * row owns, and, when the row's email is not that account's own login, whether another ESTABLISHED account holds it
 * (findUserByEmail, then isEstablishedAccount). A row that owns no account is not looked up further: it cancels by
 * its own email (no session can reach such a row; see ownsGotrueAccount; an accepted LOW on #1468). Any GoTrue failure
 * throws: the delete is a 5xx that writes nothing.
 *
 * Time of check: an account that takes the row's address between this lookup and the delete's COMMIT is not seen, so
 * its pending invitations to that address are cancelled with the rest. The window is one request; a re-invite
 * restores them (accepted on #1468, round-6 review).
 */
export async function deletedUserIdentity(userId: string, rowEmail: string): Promise<DeletedUserIdentity> {
  const account = await ownedGotrueAccount(userId);
  if (account === null || normalised(rowEmail) === '' || normalised(account.email) === normalised(rowEmail)) {
    return { account, rowEmail, rowEmailHeldElsewhere: false };
  }
  const holder = await findUserByEmail(rowEmail.trim());
  // Only an established holder makes the address someone else's: a placeholder's password is set by whoever accepts
  // the invitation, the deleted user included if they read that mailbox (round-6 breaker R6-1).
  const elsewhere = holder !== null && holder.id !== userId
    && await isEstablishedAccount(requestDb, holder.id);
  return { account, rowEmail, rowEmailHeldElsewhere: elsewhere };
}

/**
 * Deletes every invitation still pending (expired included) that could let the deleted row back in; returns how many:
 * those pinned to the GoTrue account it owned (997b runs that arm only for a canonical lower-case id, the rule above),
 * those addressed to that account's login email, and those addressed to the deleted row's email unless another
 * account holds it (`identity`, read before the locks). Addresses compare trimmed (JavaScript trim's whitespace set,
 * as the legacy accept compares) and lower-cased. Accepted invitations stay. Call LAST in the delete's own
 * transaction, after `DELETE FROM users` (997b's definer refuses while the users row exists): the invitation rows are
 * the last lock of every writer of a user's rows, as both accept routes take them.
 *
 * `deletedEmail` is the email the users DELETE returned. If it is not the one `identity` judged (a change-email landed
 * between the read and the delete), this throws: the request rolls back whole rather than cancel by an unjudged address.
 */
export async function cancelPendingInvitations(
  userId: string, deletedEmail: string, identity: DeletedUserIdentity,
): Promise<number> {
  if (normalised(deletedEmail) !== normalised(identity.rowEmail)) {
    throw new Error('deleteUser: the user\'s email changed during the delete; nothing was written, retry');
  }
  const candidates = [identity.account?.email ?? null, identity.rowEmailHeldElsewhere ? null : deletedEmail];
  const seen = new Set<string>();
  const addresses = candidates.filter((e): e is string => {
    const key = normalised(e);
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rows = await sql<{ n: number }>`SELECT public.admin_cancel_user_invitations(${userId}, ${addresses}::text[]) AS n`;
  return Number(rows[0]?.n ?? 0);
}
