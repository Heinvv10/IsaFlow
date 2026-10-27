// src/lib/auth/inviteToken.ts
import { createHash, randomBytes } from 'node:crypto';

/**
 * The single stored encoding for `company_invitations.token`.
 *
 * Two invitation systems write that column and UNIQUE(company_id, email) forces
 * them to share one row: POST /api/invitations (this one) and
 * userInvitationService.createInvitation, which has always stored sha256 and
 * hashes before every lookup. Storing the raw token from the other side meant a
 * re-invite through either UI replaced the outstanding link with an encoding the
 * other side could not match, and left a usable 64-hex invitation secret at rest
 * in the table. sha256 is the one that survives: the mailed link carries the raw
 * token, the table only ever holds its digest.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * A new raw invitation token: 32 random bytes as 64 lowercase hex. Both
 * invitation systems mint through this. The analytics scrub
 * (src/modules/analytics/scrubInviteSecrets.ts) recognises a token by that
 * shape alone, so changing the format here without changing the scrub would
 * start writing live tokens to analytics_events; its test mints through this.
 */
export function mintInviteToken(): string {
  return randomBytes(32).toString('hex');
}
