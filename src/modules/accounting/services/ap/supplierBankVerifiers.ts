/**
 * WHO may verify a supplier's bank details (forensic-controls step 1;
 * decision 5, hardened by the review of PR #679). Pure policy over the
 * company roster; supplierBankVerification.ts records the verification and
 * migration 876's guard re-checks the floor and the sole-approver roster.
 *
 *  - The verifier role (supplierBankVerifierRole) is the strictest active
 *    supplier-payment rule's role, never below the admin FLOOR.
 *  - A person who did not set the current details needs that role — unless no
 *    such person holds it AND the destination is the raised-role holder's own
 *    (whoever last re-pointed the account — the first of its setters — holds
 *    the raised role): then the floor is enough. Otherwise an owner-level
 *    payment rule plus a sole owner's own change would leave the details
 *    unverifiable for good. An admin's redirect that an owner merely touched
 *    afterwards keeps the raised requirement (fails closed).
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
  const holds = (role: string | undefined, level: string) => role !== undefined && actorRank(role) >= requiredRank(level);
  const nonSetterHoldsRole = everyone.some((m) => !setters.includes(m.id) && holds(m.role, verifierRole));
  // The destination's setter: a repoint restarts the list at its editor, and later editors are appended.
  const destinationIsRaisedRoles = holds(everyone.find((m) => m.id === setters[0])?.role, verifierRole);
  const atFloor = others.filter((m) => holds(String(m.role), floor));
  return {
    required: requiredRank(verifierRole) > requiredRank(floor) && !nonSetterHoldsRole && destinationIsRaisedRoles ? floor : verifierRole,
    setter: setters.includes(userId),
    othersAtFloor: atFloor.length,
    nonSettersAtFloor: atFloor.filter((m) => !setters.includes(String(m.user_id))).length,
  };
}

type Facts = Awaited<ReturnType<typeof facts>>;

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
  return judge(companyId, userId, ownRole, await facts(companyId, supplierId, userId, ownRole, verifierRole));
}

async function judge(companyId: string, userId: string, ownRole: string, f: Facts): Promise<{ roster: unknown } | null> {
  if (actorRank(ownRole) < requiredRank(f.required)) {
    throw new SupplierBankVerificationError('VERIFIER_ROLE_REQUIRED',
      `Verifying these bank details needs the ${f.required} role or above — the role that approves supplier payments.`);
  }
  if (!f.setter) return null;
  if (f.othersAtFloor > 0) {
    throw new SupplierBankVerificationError('SETTER_FORBIDDEN', f.nonSettersAtFloor > 0
      ? `You cannot verify these bank details: you set them. Another member with the ${f.required} role or above who did `
        + 'not set them must verify them.'
      : 'You cannot verify these bank details: you set them, and so did every other member with the admin role or above. '
        + 'A member with that role who did not set them must verify them.');
  }
  const rows = (await sql`SELECT approval_roster_snapshot(${companyId}::UUID, ${userId}::TEXT) AS roster`) as { roster: unknown }[];
  return { roster: rows[0]?.roster ?? null };
}

/**
 * For the panel, from one roster read: the role a verifier who did not set the
 * details needs now, and whether this viewer may verify (own session, and
 * assertMayVerify would pass — a hint; the POST decides).
 */
export async function verifierView(companyId: string, supplierId: string, userId: string, verifierRole: string)
  : Promise<{ required: string; canVerify: boolean }> {
  const ownRole = await ownCompanyRole(companyId, userId);
  const f = await facts(companyId, supplierId, userId, ownRole ?? '', verifierRole);
  if (ownRole === null || !(await isVerifyingSession())) return { required: f.required, canVerify: false };
  try {
    await judge(companyId, userId, ownRole, f);
    return { required: f.required, canVerify: true };
  } catch (err) {
    if (err instanceof SupplierBankVerificationError) return { required: f.required, canVerify: false };
    throw err;
  }
}
