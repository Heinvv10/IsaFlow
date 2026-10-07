/**
 * The per-company, per-document-type switch that turns approval rules from
 * advice into a gate on posting paths (R-035; Hein, 2026-09-26: opt-in, default
 * off). A row in `approval_enforcement` (migration 708) means enforced.
 *
 * ENFORCEABLE_DOCUMENT_TYPES grows by one type per PR, as each type's posting
 * paths are wired to `approvalGate` — supplier invoices since PR2, both credit-note types since PR3, customer
 * invoices since PR4, supplier payments and payment batches since PR5. Per-type rather than one company flag so a
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

export const ENFORCEABLE_DOCUMENT_TYPES: readonly DocumentType[] = [
  'supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice',
  'supplier_payment', 'payment_batch',
];

export interface ApprovalEnforcement {
  documentType: DocumentType;
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
    super(`Switching ${documentType} approval enforcement off weakens an active ${ruleRole}-level rule: only a role above ${ruleRole} (or the owner, for an owner-level rule) may do it`);
    this.name = 'ApprovalEnforcementAuthorityError';
  }
}

type Row = Record<string, unknown>;

const mapEnforcement = (r: Row): ApprovalEnforcement => ({
  documentType: String(r.document_type) as DocumentType,
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

export async function isEnforced(companyId: string, documentType: DocumentType): Promise<boolean> {
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
export function coupledTypes(documentType: DocumentType): DocumentType[] {
  return documentType === 'supplier_payment' || documentType === 'payment_batch'
    ? ['supplier_payment', 'payment_batch'] : [documentType];
}

/**
 * Idempotent: enabling an enforced type changes and records nothing. Enables
 * every coupled type with it, each row audited; the caller's savepoint makes
 * the pair atomic.
 */
export async function enableEnforcement(companyId: string, documentType: DocumentType, actor: RuleActor): Promise<void> {
  if (!ENFORCEABLE_DOCUMENT_TYPES.includes(documentType)) throw new ApprovalEnforcementUnavailableError(documentType);
  for (const type of coupledTypes(documentType)) {
    const rows = (await sql`
      INSERT INTO approval_enforcement (company_id, document_type, enabled_by)
      VALUES (${companyId}::UUID, ${type}, ${actor.userId})
      ON CONFLICT (company_id, document_type) DO NOTHING
      RETURNING *
    `) as Row[];
    if (!rows[0]) continue;
    await auditEnforcement(companyId, actor, 'create', rows[0]);
    log.info('Approval enforcement enabled', { companyId, documentType: type }, 'accounting');
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
export async function disableEnforcement(companyId: string, documentType: DocumentType, actor: RuleActor): Promise<void> {
  // Coupled types switch off together, so the authority asked is the one to
  // weaken the strictest active rule of ANY of them.
  const types = coupledTypes(documentType);
  let strictest: string | null = null;
  for (const type of types) {
    const role = await strictestActiveRuleRole(companyId, type);
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
