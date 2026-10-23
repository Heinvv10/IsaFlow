/**
 * The per-company owner lock and the live "is the caller an owner" check that
 * every service-layer owner rule shares (userAccessService role changes and
 * removals, userInvitationService owner grants). Its own module so both can
 * import it without a cycle (userAccessService re-exports the invitation
 * service).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

/** S-04: a non-owner tried to change, remove or grant an owner. Routes answer 403. */
export class OwnerProtectedError extends Error {
  constructor(message = 'Only an owner can change or remove another owner.') {
    super(message);
    this.name = 'OwnerProtectedError';
  }
}

/** The refusal for granting the owner role; the route's and trigger RC003's wording. */
export const OWNER_GRANT_REFUSED = 'Only an owner can grant the owner role.';

// Takes the per-company owner lock the member role guard takes (migs 883/886),
// then reads the actor's role. Read only after the lock, never taken from the
// request: every owner demotion takes that lock, so an actor demoted since
// withAuth read their role is seen as demoted (breaker REPRO 1). Callers that
// hold a company_users row lock take it first, as the trigger orders them.
export async function lockOwnersAndRequireOwner(
  companyId: string,
  actorUserId: string,
  refusal?: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company_owners:${companyId}`}, 0))`;
  const actor = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND lower(user_id) = lower(${actorUserId})
  `) as DbRow[];
  // By person, as the member role guard counts owners (lower-cased ids).
  if (!actor.some((r) => r.role === 'owner')) throw new OwnerProtectedError(refusal);
}
