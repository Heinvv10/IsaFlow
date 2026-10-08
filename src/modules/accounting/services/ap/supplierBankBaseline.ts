/**
 * Supplier bank-detail verification (forensic-controls step 1; migration 876)
 * — the pieces the enforcement switch needs, kept free of any import from the
 * approval kernel so approvalEnforcement.ts can call them without a cycle:
 * the typed refusal, the "a person in their own session" check, and the
 * switch-on baseline (Hein, decision 3).
 */
import { sql } from '@/lib/neon';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { suppliersWithBankDetailsSetBy } from './supplierPaymentAuthors';

export type SupplierBankVerificationErrorCode =
  | 'IMPERSONATION_FORBIDDEN' | 'VERIFIER_ROLE_REQUIRED' | 'SETTER_FORBIDDEN' | 'NOT_ENFORCED'
  | 'NOT_FOUND' | 'NO_BANK_DETAILS' | 'FINGERPRINT_STALE' | 'ALREADY_VERIFIED';

const STATUS: Record<SupplierBankVerificationErrorCode, 403 | 404 | 409> = {
  IMPERSONATION_FORBIDDEN: 403, VERIFIER_ROLE_REQUIRED: 403, SETTER_FORBIDDEN: 403, NOT_FOUND: 404,
  NOT_ENFORCED: 409, NO_BANK_DETAILS: 409, FINGERPRINT_STALE: 409, ALREADY_VERIFIED: 409,
};

/** A refusal to verify (or to switch the control on). Raised before anything is written. */
export class SupplierBankVerificationError extends Error {
  readonly status: 403 | 404 | 409;
  constructor(readonly code: SupplierBankVerificationErrorCode, message: string) {
    super(message);
    this.name = 'SupplierBankVerificationError';
    this.status = STATUS[code];
  }
}

/**
 * Decision 7: a verification — and the baseline, which is one — is made by a
 * person in their own cookie session. "Login as" is refused, and so is a
 * context that cannot show it is not one (no session claims: an MCP tool, a
 * job), exactly as R-035 refuses approval decisions (assertDecidingSession).
 */
/**
 * The person's company role while they are a member in good standing — read
 * from their own company_users and users rows (visible to app_user), never
 * from the caller; null otherwise. Verifying and switching on rank on this,
 * the role migration 876's guard checks too.
 */
export async function ownCompanyRole(companyId: string, userId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT cu.role, u.is_active, u.status, u.suspended_at
    FROM company_users cu JOIN users u ON u.id = cu.user_id
    WHERE cu.company_id = ${companyId}::UUID AND cu.user_id = ${userId}
  `) as { role: string; is_active: boolean | null; status: string | null; suspended_at: string | null }[];
  return rows[0] && isActiveUserAccount(rows[0]) ? String(rows[0].role) : null;
}

/** Whether this request is a person in their own session — the hint the panel's Verify form follows. */
export async function isVerifyingSession(): Promise<boolean> {
  return (await currentSessionActor()) === 'self';
}

export async function assertVerifyingSession(): Promise<void> {
  const actor = await currentSessionActor();
  if (actor === 'self') return;
  throw new SupplierBankVerificationError('IMPERSONATION_FORBIDDEN', actor === 'impersonation'
    ? 'Supplier bank details cannot be verified while impersonating another user. End the impersonation and act as yourself.'
    : 'Supplier bank details can only be verified by a person signed in as themselves.');
}

/**
 * Decision 3: switching the control on accepts every supplier's CURRENT bank
 * details, recorded as a `baseline` by the person who switched it on, at the
 * current fingerprint. Called by enableEnforcement in the transaction that
 * inserted the switch row (the 876 guard accepts a baseline only then). The
 * suppliers are share-locked first, in id order (the order the outbound gate
 * takes), so an edit in flight is waited for rather than half-baselined.
 * Left out, so they stay unverified until someone else looks: soft-deleted
 * suppliers (one restored later is then checked before it is paid);
 * suppliers that already have verification history — they keep their
 * derived state, so switching off and on again cannot accept a change that
 * is unverified now; and suppliers whose current details the switcher set.
 * The 876 guard refuses both of the latter baselines too. Returns how many
 * were baselined.
 */
export async function recordBankBaseline(companyId: string, userId: string): Promise<number> {
  await sql`SELECT id FROM suppliers WHERE company_id = ${companyId}::UUID ORDER BY id FOR SHARE`;
  const own = await suppliersWithBankDetailsSetBy(companyId, userId);
  const rows = await sql`
    INSERT INTO supplier_bank_verifications (company_id, supplier_id, fingerprint, kind, verified_by)
    SELECT s.company_id, s.id,
           supplier_bank_fingerprint(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type, s.bank_account_holder),
           'baseline', ${userId}
    FROM suppliers s
    WHERE s.company_id = ${companyId}::UUID AND s.deleted_at IS NULL AND s.id <> ALL(${own}::UUID[])
      AND supplier_bank_details_present(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type, s.bank_account_holder)
      AND NOT EXISTS (SELECT 1 FROM supplier_bank_verifications v WHERE v.company_id = s.company_id AND v.supplier_id = s.id)
    RETURNING id
  `;
  return rows.length;
}
