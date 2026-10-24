/**
 * The per-company owner lock key and the owner refusal that every
 * service-layer owner rule shares (memberWrites role changes and removals,
 * userInvitationService owner grants). Its own module so each can import it
 * without a cycle (userAccessService re-exports both).
 */

/** S-04: a non-owner tried to change, remove or grant an owner. Routes answer 403. */
export class OwnerProtectedError extends Error {
  constructor(message = 'Only an owner can change or remove another owner.') {
    super(message);
    this.name = 'OwnerProtectedError';
  }
}

/** The refusal for granting the owner role; the route's and trigger RC003's wording. */
export const OWNER_GRANT_REFUSED = 'Only an owner can grant the owner role.';

/** The advisory lock key every owner demotion and owner grant takes (migs 883/886, the member role guard). */
export const ownerLockKey = (companyId: string): string => `company_owners:${companyId}`;
