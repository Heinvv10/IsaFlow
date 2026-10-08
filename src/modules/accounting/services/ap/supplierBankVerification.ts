/**
 * Supplier bank-detail verification (forensic-controls rebuild step 1; Hein's
 * decisions 2026-10-08) — reading a supplier's verification state and
 * recording a person's verification. The gate on money leaving is
 * supplierBankVerificationGate.ts; the switch-on baseline and the typed
 * refusal are supplierBankBaseline.ts; the database side is migration 876.
 *
 * State is DERIVED (decision 4): verified iff the latest verification's
 * fingerprint equals the fingerprint of the supplier's current bank columns,
 * computed only by `supplier_bank_fingerprint` in SQL.
 *
 * Who may verify (decision 5): a person in their own session (decision 7)
 * whose role reaches the verifier role (supplierBankVerifierRole: the
 * strictest supplier-payment rule's, else admin), who did not set the current
 * details — unless nobody else could (R-035's sole-approver exception), which
 * is recorded `self_verified` with the roster snapshot.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { isEnforced, SUPPLIER_BANK_VERIFIER_FLOOR, supplierBankVerifierRole } from '../gl/approvalEnforcement';
import { actorRank, requiredRank } from '../gl/approvalRank';
import { SUPPLIER_BANK_DETAILS } from '../gl/approvalRuleOptions';
import { logAuditOrThrow } from '../core/auditTrailService';
import { assertVerifyingSession, isVerifyingSession, SupplierBankVerificationError } from './supplierBankBaseline';
import { isBankDetailsSetter, suppliersWithBankDetailsSetBy } from './supplierPaymentAuthors';

export const VERIFICATION_METHODS = ['phone_known_number', 'bank_confirmation_letter', 'in_person', 'other'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export const isVerificationMethod = (v: unknown): v is VerificationMethod =>
  typeof v === 'string' && (VERIFICATION_METHODS as readonly string[]).includes(v);
export const NOTE_MAX = 500;

export type BankVerificationState = 'not_enforced' | 'no_bank_details' | 'verified' | 'unverified';

export interface BankVerificationEntry {
  kind: 'baseline' | 'verified' | 'self_verified';
  method: VerificationMethod | null;
  note: string | null;
  verifiedBy: string;
  verifiedByName: string | null;
  verifiedAt: string;
}

export interface SupplierBankVerificationView {
  supplierId: string;
  enforced: boolean;
  state: BankVerificationState;
  /** The fingerprint of the details shown — echoed back by a verify, refused if they changed since. */
  fingerprint: string | null;
  bank: { bankName: string | null; maskedAccount: string | null; branchCode: string | null; accountType: string | null; holder: string | null };
  verifierRole: string;
  /** Whether the viewer may verify these details now (a hint; the POST decides). */
  canVerify: boolean;
  latest: BankVerificationEntry | null;
  history: BankVerificationEntry[];
}

type Row = Record<string, unknown>;
const text = (v: unknown) => (v == null || v === '' ? null : String(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

function mask(account: unknown): string | null {
  const digits = String(account ?? '').replace(/\D/g, '');
  return digits ? `•••• ${digits.slice(-4)}` : null;
}

/** The supplier's bank columns with the fingerprint, present and verified flags — company-scoped; null when no such supplier. */
async function readSupplier(companyId: string, supplierId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT s.id, s.name, s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type, s.bank_account_holder,
           supplier_bank_fingerprint(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type,
                                     s.bank_account_holder) AS fingerprint,
           supplier_bank_details_present(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type,
                                         s.bank_account_holder) AS present,
           supplier_bank_verified(s.company_id, s.id) AS verified
    FROM suppliers s WHERE s.id = ${supplierId}::UUID AND s.company_id = ${companyId}::UUID
  `) as Row[];
  return rows[0] ?? null;
}

/**
 * The refusal for a setter, or 'self_verified' with the roster when they are
 * the sole approver: no OTHER active member of the company reaches the
 * verifier FLOOR (admin) — R-035 Q2, platform roles counted, so it fails
 * closed. Judged against the floor, not the verifier role: a setter who
 * raised the role with a payment rule would otherwise make themselves the
 * only one who qualifies (review of PR #679, REPRO 2). Migration 876's guard
 * checks the same thing on the roster. Read through
 * approval_company_other_members (SECURITY DEFINER; app_user cannot see the
 * roster), which answers only inside the caller's own request.
 */
async function setterOutcome(companyId: string, userId: string, verifierRole: string): Promise<{ roster: unknown }> {
  const others = (await sql`
    SELECT m.role, m.is_active, m.status, m.suspended_at
    FROM approval_company_other_members(${companyId}::UUID, ${userId}::TEXT) m
  `) as { role: string; is_active: boolean | null; status: string | null; suspended_at: string | null }[];
  const floor = SUPPLIER_BANK_VERIFIER_FLOOR;
  const n = others.filter((m) => isActiveUserAccount(m) && actorRank(String(m.role)) >= requiredRank(floor)).length;
  if (n > 0) {
    const raised = requiredRank(verifierRole) > requiredRank(floor)
      ? ` (they need the ${verifierRole} role the payment rules demand)` : '';
    throw new SupplierBankVerificationError('SETTER_FORBIDDEN', 'You cannot verify these bank details: you set them, and '
      + `${n} other member${n === 1 ? '' : 's'} with the ${floor} role or above could — one who did not set them must${raised}.`);
  }
  const rows = (await sql`SELECT approval_roster_snapshot(${companyId}::UUID, ${userId}::TEXT) AS roster`) as Row[];
  return { roster: rows[0]?.roster ?? null };
}

/** May `role` verify, as a hint for the panel: own session, rank, and not a setter unless the sole approver. */
async function mayVerify(companyId: string, supplierId: string, userId: string, role: string, verifierRole: string): Promise<boolean> {
  if (!(await isVerifyingSession()) || actorRank(role) < requiredRank(verifierRole)) return false;
  if (!(await isBankDetailsSetter(companyId, supplierId, userId))) return true;
  try {
    await setterOutcome(companyId, userId, verifierRole);
    return true;
  } catch (err) {
    if (err instanceof SupplierBankVerificationError) return false;
    throw err;
  }
}

/** State and history (latest 20) of one supplier of `companyId`; null when the company has no such supplier. */
export async function getSupplierBankVerification(companyId: string, supplierId: string, viewer: { userId: string; role: string })
  : Promise<SupplierBankVerificationView | null> {
  const s = await readSupplier(companyId, supplierId);
  if (!s) return null;
  const enforced = await isEnforced(companyId, SUPPLIER_BANK_DETAILS);
  const verifierRole = await supplierBankVerifierRole(companyId);
  const history = ((await sql`
    SELECT v.kind, v.method, v.note, v.verified_by, v.verified_at,
           approval_company_member_name(v.company_id, v.verified_by) AS verified_by_name
    FROM supplier_bank_verifications v
    WHERE v.company_id = ${companyId}::UUID AND v.supplier_id = ${supplierId}::UUID
    ORDER BY v.verified_at DESC, v.seq DESC LIMIT 20
  `) as Row[]).map((r): BankVerificationEntry => ({
    kind: String(r.kind) as BankVerificationEntry['kind'],
    method: isVerificationMethod(r.method) ? r.method : null,
    note: text(r.note),
    verifiedBy: String(r.verified_by),
    verifiedByName: text(r.verified_by_name),
    verifiedAt: iso(r.verified_at),
  }));
  const state: BankVerificationState = !enforced ? 'not_enforced' : s.present !== true ? 'no_bank_details'
    : s.verified === true ? 'verified' : 'unverified';
  return {
    supplierId,
    enforced,
    state,
    fingerprint: s.present === true ? String(s.fingerprint) : null,
    bank: {
      bankName: text(s.bank_name), maskedAccount: mask(s.bank_account_number), branchCode: text(s.bank_branch_code),
      accountType: text(s.bank_account_type), holder: text(s.bank_account_holder),
    },
    verifierRole,
    canVerify: state === 'unverified' && await mayVerify(companyId, supplierId, viewer.userId, viewer.role, verifierRole),
    latest: history[0] ?? null,
    history,
  };
}

export interface VerifyInput {
  companyId: string;
  userId: string;
  /** company_users.role, as withAuth established it. */
  role: string;
  email?: string;
  supplierId: string;
  /** The fingerprint of the details the verifier SAW (GET's `fingerprint`). */
  fingerprint: string;
  method: VerificationMethod;
  note: string;
}

/**
 * Records a person's verification of the supplier's CURRENT bank details, or
 * throws SupplierBankVerificationError before writing anything. The supplier
 * row is locked FOR UPDATE (the lock every bank-detail writer takes) and then
 * re-read, so a concurrent edit either lands first — and the fingerprint the
 * verifier saw no longer matches (FINGERPRINT_STALE) — or waits for this
 * verification and then unverifies it. Audited in the same transaction.
 */
export async function verifySupplierBankDetails(input: VerifyInput): Promise<{ id: string; kind: 'verified' | 'self_verified' }> {
  const { companyId, userId, supplierId } = input;
  await assertVerifyingSession();
  if (!(await isEnforced(companyId, SUPPLIER_BANK_DETAILS))) {
    throw new SupplierBankVerificationError('NOT_ENFORCED', 'Supplier bank verification is not switched on for this company.');
  }
  const verifierRole = await supplierBankVerifierRole(companyId);
  if (actorRank(input.role) < requiredRank(verifierRole)) {
    throw new SupplierBankVerificationError('VERIFIER_ROLE_REQUIRED',
      `Verifying supplier bank details needs the ${verifierRole} role or above — the role that approves supplier payments.`);
  }
  const locked = await sql`SELECT id FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`;
  const s = locked.length > 0 ? await readSupplier(companyId, supplierId) : null;
  if (!s) throw new SupplierBankVerificationError('NOT_FOUND', 'Supplier not found');
  if (s.present !== true) throw new SupplierBankVerificationError('NO_BANK_DETAILS', 'This supplier has no bank details to verify.');
  if (String(s.fingerprint) !== input.fingerprint) {
    throw new SupplierBankVerificationError('FINGERPRINT_STALE',
      'These bank details changed after you opened them. Reload the supplier and verify the details now on file.');
  }
  if (s.verified === true) throw new SupplierBankVerificationError('ALREADY_VERIFIED', 'These bank details are already verified.');

  const self = await isBankDetailsSetter(companyId, supplierId, userId) ? await setterOutcome(companyId, userId, verifierRole) : null;
  const kind = self ? 'self_verified' : 'verified';
  const rows = (await sql`
    INSERT INTO supplier_bank_verifications (company_id, supplier_id, fingerprint, kind, method, note, verified_by, roster_snapshot)
    VALUES (${companyId}::UUID, ${supplierId}::UUID, ${input.fingerprint}, ${kind}, ${input.method}, ${input.note.trim()},
            ${userId}, ${self ? JSON.stringify(self.roster) : null}::JSONB)
    RETURNING id
  `) as Row[];
  const id = String(rows[0]!.id);
  await logAuditOrThrow({
    companyId, userId, userEmail: input.email, action: 'approve', entityType: 'supplier_bank_details', entityId: supplierId,
    entityRef: String(s.name ?? supplierId).slice(0, 100),
    changes: { fields: [], metadata: { verificationId: id, kind, method: input.method, fingerprint: input.fingerprint, verifierRole } },
  });
  log.info('Supplier bank details verified', { companyId, supplierId, kind, method: input.method }, 'accounting');
  return { id, kind };
}

/**
 * The count beside the switch, for `viewerId`: while on, suppliers (not
 * soft-deleted) with bank details that are unverified now; while off,
 * exactly those switching on would accept as the baseline — no verification
 * history (recordBankBaseline) and details the viewer did not set.
 */
export async function bankDetailsPreview(companyId: string, viewerId: string): Promise<number> {
  const enforced = await isEnforced(companyId, SUPPLIER_BANK_DETAILS);
  const own = enforced ? [] : await suppliersWithBankDetailsSetBy(companyId, viewerId);
  const rows = (await sql`
    SELECT count(*)::INT AS n FROM suppliers s
    WHERE s.company_id = ${companyId}::UUID AND s.deleted_at IS NULL
      AND supplier_bank_details_present(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type,
                                        s.bank_account_holder)
      AND CASE WHEN ${enforced} THEN NOT supplier_bank_verified(s.company_id, s.id)
               ELSE s.id <> ALL(${own}::UUID[])
                    AND NOT EXISTS (SELECT 1 FROM supplier_bank_verifications v
                                    WHERE v.company_id = s.company_id AND v.supplier_id = s.id) END
  `) as Row[];
  return Number(rows[0]?.n ?? 0);
}
