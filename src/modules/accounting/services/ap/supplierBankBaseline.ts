/**
 * Supplier bank-detail verification (forensic-controls step 1; migration 876)
 * — the pieces the enforcement switch needs, kept free of any import from the
 * approval kernel so approvalEnforcement.ts can call them without a cycle:
 * the typed refusal and the "a person in their own session" check. The
 * switch-on baseline (Hein, decision 3) is written by approval_enforcement_set
 * (migration 881, R-035 N1b B) in the transaction that inserts the switch row
 * — only the company's FIRST switch-on (bankVerificationEverOn's test, in
 * SQL); suppliers share-locked in id order; every non-deleted supplier with
 * bank details, no verification history, and details the switcher did not
 * set. The 876 guard refuses any other baseline.
 */
import { sql } from '@/lib/neon';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';

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
 * Whether supplier bank verification was ever switched on for the company
 * before: any verification row, or an earlier enable in the audit log. Only
 * the FIRST switch-on writes a baseline (review of PR #679, R2-1): after it,
 * every supplier created, given details or changed — even while the control
 * was later off — needs a person's verify; switching off and on again
 * accepts nothing. (audit_log is app_user-writable — the N1 boundary; the 876
 * guard independently refuses a baseline once the company has any row.)
 */
export async function bankVerificationEverOn(companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (SELECT 1 FROM supplier_bank_verifications WHERE company_id = ${companyId}::UUID)
        OR EXISTS (SELECT 1 FROM audit_log WHERE company_id = ${companyId}::UUID AND entity_type = 'approval_enforcement'
                     AND entity_ref = 'supplier_bank_details' AND action = 'create') AS on_before
  `) as { on_before: boolean }[];
  return rows[0]?.on_before === true;
}
