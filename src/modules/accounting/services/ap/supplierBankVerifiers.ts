/**
 * WHO may verify a supplier's bank details (forensic-controls step 1;
 * decision 5, hardened by the review of PR #679). Pure policy over the
 * company roster; supplierBankVerification.ts records the verification and
 * migration 876's guard re-checks the floor and the sole-approver roster.
 *
 *  - The verifier role (supplierBankVerifierRole) is the strictest active
 *    supplier-payment rule's role, never below the admin FLOOR.
 *  - A person who did not set the current details needs that role — unless no
 *    such person holds it (a raised role whose only holders set the details),
 *    when the floor is enough: otherwise an owner-level payment rule plus a
 *    sole owner's own change would leave the details unverifiable for good.
 *  - A setter verifies only as R-035's sole approver: no OTHER active member
 *    reaches the floor. Judged on the floor, never on the raised role, so a
 *    setter cannot raise the role to make themselves the only one who
 *    qualifies. Recorded `self_verified` with the roster snapshot.
 *  - The verifier's own role and standing are read from the database
 *    (company_users and users, own rows), not taken from the caller.
 * The roster comes through approval_company_other_members (SECURITY DEFINER;
 * it answers only for the request's own user and company).
 */
import { sql } from '@/lib/neon';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { SUPPLIER_BANK_VERIFIER_FLOOR } from '../gl/approvalEnforcement';
import { actorRank, requiredRank } from '../gl/approvalRank';
import { isVerifyingSession, ownCompanyRole, SupplierBankVerificationError } from './supplierBankBaseline';
import { bankDetailsSetters } from './supplierPaymentAuthors';

type Member = { user_id: string; role: string; is_active: boolean | null; status: string | null; suspended_at: string | null };

/** The role a verifier who did NOT set the details needs, and the facts behind it. */
async function facts(companyId: string, supplierId: string, userId: string, ownRole: string, verifierRole: string) {
  const floor = SUPPLIER_BANK_VERIFIER_FLOOR;
  const setters = await bankDetailsSetters(companyId, supplierId);
  const others = ((await sql`
    SELECT m.user_id, m.role, m.is_active, m.status, m.suspended_at
    FROM approval_company_other_members(${companyId}::UUID, ${userId}::TEXT) m
  `) as Member[]).filter((m) => isActiveUserAccount(m));
  const everyone = [...others.map((m) => ({ id: String(m.user_id), role: String(m.role) })), { id: userId, role: ownRole }];
  const nonSetterHoldsRole = everyone.some((m) => !setters.includes(m.id) && actorRank(m.role) >= requiredRank(verifierRole));
  return {
    required: requiredRank(verifierRole) > requiredRank(floor) && !nonSetterHoldsRole ? floor : verifierRole,
    setter: setters.includes(userId),
    othersAtFloor: others.filter((m) => actorRank(String(m.role)) >= requiredRank(floor)).length,
  };
}

/** The role a non-setter needs to verify this supplier's details now (shown on the panel). */
export async function requiredVerifierRole(companyId: string, supplierId: string, userId: string, verifierRole: string): Promise<string> {
  return (await facts(companyId, supplierId, userId, (await ownCompanyRole(companyId, userId)) ?? '', verifierRole)).required;
}

/**
 * Throws SupplierBankVerificationError unless `userId` may verify the details
 * now; returns the roster snapshot when they may only as the sole approver
 * (a `self_verified` row), else null.
 */
export async function assertMayVerify(companyId: string, supplierId: string, userId: string, verifierRole: string)
  : Promise<{ roster: unknown } | null> {
  const ownRole = await ownCompanyRole(companyId, userId);
  if (ownRole === null) {
    throw new SupplierBankVerificationError('VERIFIER_ROLE_REQUIRED', 'You hold no active role in this company, so you cannot verify bank details.');
  }
  const f = await facts(companyId, supplierId, userId, ownRole, verifierRole);
  if (actorRank(ownRole) < requiredRank(f.required)) {
    throw new SupplierBankVerificationError('VERIFIER_ROLE_REQUIRED',
      `Verifying these bank details needs the ${f.required} role or above — the role that approves supplier payments.`);
  }
  if (!f.setter) return null;
  if (f.othersAtFloor > 0) {
    throw new SupplierBankVerificationError('SETTER_FORBIDDEN', 'You cannot verify these bank details: you set them. Another '
      + `member with the ${f.required} role or above who did not set them must verify them.`);
  }
  const rows = (await sql`SELECT approval_roster_snapshot(${companyId}::UUID, ${userId}::TEXT) AS roster`) as { roster: unknown }[];
  return { roster: rows[0]?.roster ?? null };
}

/** The panel's hint: may this viewer verify now (own session, and assertMayVerify would pass)? */
export async function mayVerify(companyId: string, supplierId: string, userId: string, verifierRole: string): Promise<boolean> {
  if (!(await isVerifyingSession())) return false;
  try {
    await assertMayVerify(companyId, supplierId, userId, verifierRole);
    return true;
  } catch (err) {
    if (err instanceof SupplierBankVerificationError) return false;
    throw err;
  }
}
