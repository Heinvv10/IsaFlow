/**
 * The per-company, per-document-type switch that turns approval rules from
 * advice into a gate on posting paths (R-035; Hein, 2026-09-26: opt-in, default
 * off). A row in `approval_enforcement` (migration 708) means enforced.
 *
 * ENFORCEABLE_DOCUMENT_TYPES grows by one type per PR, as each type's posting
 * paths are wired to `approvalGate` — supplier invoices since PR2, both credit-note types since PR3, customer
 * invoices since PR4, supplier payments and payment batches since PR5, manual journals since PR6. Per-type rather
 * than one company flag so a
 * company that opted into supplier invoices is not silently enrolled in
 * journals when that PR lands.
 *
 * Turning enforcement OFF weakens a control, so it demands the authority to
 * WEAKEN the strictest ACTIVE rule of that type — `mayWeakenAtLevel`, the one
 * predicate rule edits use (R-048): a rank strictly above that rule, or owner
 * at owner level — and is audited. Otherwise an admin switches enforcement off
 * to post their own bill, the round-3 bypass by another lever.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DocumentType } from './approvalService';
import { requiredRank } from './approvalAuthority';
import { mayWeakenAtLevel, type RuleActor } from './approvalRuleGuards';
import { logAuditOrThrow } from '../core/auditTrailService';
import { ENFORCEABLE_TYPES, SUPPLIER_BANK_DETAILS, type EnforcementType } from './approvalRuleOptions';
import { actorRank } from './approvalRank';
import {
  assertVerifyingSession, ownCompanyRole, recordBankBaseline, SupplierBankVerificationError,
} from '../ap/supplierBankBaseline';

// The list lives in approvalRuleOptions.ts (no database import, so the rule form
// offers the same types); re-exported for every existing import site.
export { ENFORCEABLE_DOCUMENT_TYPES, ENFORCEABLE_TYPES } from './approvalRuleOptions';

export interface ApprovalEnforcement {
  documentType: EnforcementType;
  enabledAt: string;
  enabledBy: string;
}

/** Enabling a type whose posting paths do not consult the gate yet. */
export class ApprovalEnforcementUnavailableError extends Error {
  readonly code = 'NOT_ENFORCEABLE';
  constructor(documentType: string) {
    super(`Approval enforcement is not available for ${documentType} yet`);
    this.name = 'ApprovalEnforcementUnavailableError';
  }
}

/** Disabling needs the authority to weaken the strictest active rule of the type (R-048). Same reason code as rule edits. */
export class ApprovalEnforcementAuthorityError extends Error {
  readonly code = 'RULE_AUTHORITY_REQUIRED';
  constructor(documentType: string, ruleRole: string) {
    super(documentType === SUPPLIER_BANK_DETAILS
      ? `Switching supplier bank verification off lets unverified bank details be paid. Bank details are verified at the ${ruleRole} `
        + `level, so only a role above ${ruleRole} (or the owner, at owner level) may switch it off`
      : `Switching ${documentType} approval enforcement off weakens an active ${ruleRole}-level rule: only a role above ${ruleRole} (or the owner, for an owner-level rule) may do it`);
    this.name = 'ApprovalEnforcementAuthorityError';
  }
}

type Row = Record<string, unknown>;

const mapEnforcement = (r: Row): ApprovalEnforcement => ({
  documentType: String(r.document_type) as EnforcementType,
  enabledAt: String(r.enabled_at),
  enabledBy: String(r.enabled_by),
});

export async function listEnforcement(companyId: string): Promise<ApprovalEnforcement[]> {
  const rows = (await sql`
    SELECT document_type, enabled_at, enabled_by FROM approval_enforcement
    WHERE company_id = ${companyId} ORDER BY document_type
  `) as Row[];
  return rows.map(mapEnforcement);
}

/**
 * Active rules of the legacy `credit_note` type: they govern neither
 * credit-note type (R-035 PR3), so the Enforce switch warns that they must be
 * re-created as customer / supplier credit-note rules (review B2).
 */
export async function countLegacyCreditNoteRules(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n FROM approval_rules
    WHERE company_id = ${companyId} AND document_type = 'credit_note' AND is_active = true
  `) as Row[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * Active rules of the legacy `payment` type: they govern neither supplier
 * payments nor payment batches (R-035 PR5), so both payment switches warn.
 */
export async function countLegacyPaymentRules(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n FROM approval_rules
    WHERE company_id = ${companyId} AND document_type = 'payment' AND is_active = true
  `) as Row[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * Active rules of the legacy `journal_entry` type: they govern no journal —
 * manual journals have their own type (R-035 PR6) — so the manual-journal
 * switch warns about them.
 */
export async function countLegacyJournalRules(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n FROM approval_rules
    WHERE company_id = ${companyId} AND document_type = 'journal_entry' AND is_active = true
  `) as Row[];
  return Number(rows[0]?.n ?? 0);
}

export async function isEnforced(companyId: string, documentType: EnforcementType): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM approval_enforcement WHERE company_id = ${companyId} AND document_type = ${documentType}
  `) as Row[];
  return rows.length > 0;
}

async function auditEnforcement(companyId: string, actor: RuleActor, action: 'create' | 'delete',
  row: Row, metadata: Record<string, string> = {}): Promise<void> {
  await logAuditOrThrow({
    companyId,
    userId: actor.userId,
    userEmail: actor.email,
    action,
    entityType: 'approval_enforcement',
    entityId: String(row.id),
    entityRef: String(row.document_type),
    changes: { fields: [], metadata: { actorRole: actor.role, enforcementId: String(row.id), ...metadata } },
  });
}

/**
 * The types one switch moves (Hein, 2026-10-06, D1). A single payment and a
 * one-line batch pay the same bill, so the two payment types are COUPLED:
 * enforcing one alone left the other path to the same money open (R-035 PR5
 * round 1). Every other type is its own switch.
 */
export function coupledTypes(documentType: EnforcementType): EnforcementType[] {
  return documentType === 'supplier_payment' || documentType === 'payment_batch'
    ? ['supplier_payment', 'payment_batch'] : [documentType];
}

/** The floor of the verifier role: R-035's default (an unreadable approver_role ranks as admin), the payment starter rules' role. */
export const SUPPLIER_BANK_VERIFIER_FLOOR = 'admin';

/**
 * Who may verify supplier bank details (decision 5): whoever may approve any
 * supplier payment — the role of the strictest ACTIVE supplier_payment or
 * payment_batch rule (coupled, so both are read) — but never below
 * SUPPLIER_BANK_VERIFIER_FLOOR. A rule can only RAISE it: otherwise an admin
 * could plant an inert low-level payment rule (a threshold no payment
 * reaches — the amount is not read here) and so lower who may verify, switch
 * on and switch off (review of PR #679, REPRO 1).
 */
export async function supplierBankVerifierRole(companyId: string): Promise<string> {
  let strictest = SUPPLIER_BANK_VERIFIER_FLOOR;
  for (const type of coupledTypes('supplier_payment')) {
    const role = await strictestActiveRuleRole(companyId, type as DocumentType);
    if (role !== null && requiredRank(role) > requiredRank(strictest)) strictest = role;
  }
  return strictest;
}

/**
 * Idempotent: enabling an enforced type changes and records nothing. Enables
 * every coupled type with it, each row audited; the caller's savepoint makes
 * the pair atomic.
 *
 * Supplier bank details: switching on is itself a verification of every
 * supplier's current details (the baseline), so it is refused, before any
 * write, to anyone who could not verify — an impersonated or claim-less
 * session, or a role below the verifier role.
 */
export async function enableEnforcement(companyId: string, documentType: EnforcementType, actor: RuleActor): Promise<void> {
  if (!ENFORCEABLE_TYPES.includes(documentType)) throw new ApprovalEnforcementUnavailableError(documentType);
  const bank = documentType === SUPPLIER_BANK_DETAILS;
  if (bank) {
    await assertVerifyingSession();
    const role = await supplierBankVerifierRole(companyId);
    const own = await ownCompanyRole(companyId, actor.userId); // the role 876's guard checks, not the caller's word
    if (own === null || actorRank(own) < requiredRank(role)) {
      throw new SupplierBankVerificationError('VERIFIER_ROLE_REQUIRED', 'Switching supplier bank verification on accepts '
        + `every supplier's current bank details as verified, so it needs the ${role} role or above — the role that verifies them.`);
    }
  }
  for (const type of coupledTypes(documentType)) {
    const rows = (await sql`
      INSERT INTO approval_enforcement (company_id, document_type, enabled_by)
      VALUES (${companyId}::UUID, ${type}, ${actor.userId})
      ON CONFLICT (company_id, document_type) DO NOTHING
      RETURNING *
    `) as Row[];
    if (!rows[0]) continue;
    const baseline = bank ? { baselineSuppliers: String(await recordBankBaseline(companyId, actor.userId)) } : undefined;
    await auditEnforcement(companyId, actor, 'create', rows[0], baseline);
    log.info('Approval enforcement enabled', { companyId, documentType: type, ...baseline }, 'accounting');
  }
}

/**
 * The role the strictest ACTIVE rule of the type demands, or null when none is
 * active. An unreadable approver_role ranks as 'admin', the same floor the
 * decide path uses. Shared by disabling and by the import exemption's rank check.
 */
export async function strictestActiveRuleRole(companyId: string, documentType: DocumentType): Promise<string | null> {
  const rules = (await sql`
    SELECT approver_role FROM approval_rules
    WHERE company_id = ${companyId} AND document_type = ${documentType} AND is_active = true
  `) as Row[];
  return rules
    .map((r) => (r.approver_role != null ? String(r.approver_role) : 'admin'))
    .reduce<string | null>((top, role) => (top === null || requiredRank(role) > requiredRank(top) ? role : top), null);
}

/**
 * Refuses (ApprovalEnforcementAuthorityError, a 403) when the actor may not
 * weaken the strictest active rule of the type — or of any type coupled with
 * it (`mayWeakenAtLevel`). Idempotent otherwise; disables every coupled type.
 */
export async function disableEnforcement(companyId: string, documentType: EnforcementType, actor: RuleActor): Promise<void> {
  // Coupled types switch off together, so the authority asked is the one to
  // weaken the strictest active rule of ANY of them. Supplier bank details
  // have no rule of their own: the level weakened is the verifier role, so
  // the person who set a supplier's details cannot simply switch the check off.
  const types = coupledTypes(documentType);
  // …and, like switching on, only by a person in their own session ("login as" may not weaken it either).
  if (documentType === SUPPLIER_BANK_DETAILS) await assertVerifyingSession();
  let strictest: string | null = documentType === SUPPLIER_BANK_DETAILS ? await supplierBankVerifierRole(companyId) : null;
  for (const type of documentType === SUPPLIER_BANK_DETAILS ? [] : types) {
    const role = await strictestActiveRuleRole(companyId, type as DocumentType);
    if (role !== null && (strictest === null || requiredRank(role) > requiredRank(strictest))) strictest = role;
  }
  if (strictest !== null && !mayWeakenAtLevel(actor.role, strictest)) {
    // No audit_log action fits a refusal, and withAuth commits a 4xx — so the
    // attempt to weaken the control is recorded here rather than not at all.
    log.warn('Approval enforcement disable refused', {
      companyId, documentType, actorId: actor.userId, actorRole: actor.role, strictestRuleRole: strictest,
    }, 'accounting');
    throw new ApprovalEnforcementAuthorityError(documentType, strictest);
  }
  for (const type of types) {
    const rows = (await sql`
      DELETE FROM approval_enforcement WHERE company_id = ${companyId} AND document_type = ${type}
      RETURNING *
    `) as Row[];
    if (!rows[0]) continue;
    await auditEnforcement(companyId, actor, 'delete', rows[0], strictest ? { strictestRuleRole: strictest } : {});
    log.info('Approval enforcement disabled', { companyId, documentType: type }, 'accounting');
  }
}
