/**
 * The per-company, per-document-type switch that turns approval rules from
 * advice into a gate on posting paths (R-035; Hein, 2026-09-26: opt-in, default
 * off). A row in `approval_enforcement` (migration 708) means enforced.
 *
 * ENFORCEABLE_DOCUMENT_TYPES grows by one type per PR, as each type's posting
 * paths are wired to `approvalGate` — supplier invoices since PR2. Per-type rather than one company flag so a
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

export const ENFORCEABLE_DOCUMENT_TYPES: readonly DocumentType[] = ['supplier_invoice'];

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

/** Idempotent: enabling an enforced type changes and records nothing. */
export async function enableEnforcement(companyId: string, documentType: DocumentType, actor: RuleActor): Promise<void> {
  if (!ENFORCEABLE_DOCUMENT_TYPES.includes(documentType)) throw new ApprovalEnforcementUnavailableError(documentType);
  const rows = (await sql`
    INSERT INTO approval_enforcement (company_id, document_type, enabled_by)
    VALUES (${companyId}::UUID, ${documentType}, ${actor.userId})
    ON CONFLICT (company_id, document_type) DO NOTHING
    RETURNING *
  `) as Row[];
  if (!rows[0]) return;
  await auditEnforcement(companyId, actor, 'create', rows[0]);
  log.info('Approval enforcement enabled', { companyId, documentType }, 'accounting');
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
 * weaken the strictest active rule of the type (`mayWeakenAtLevel`). Idempotent otherwise.
 */
export async function disableEnforcement(companyId: string, documentType: DocumentType, actor: RuleActor): Promise<void> {
  const strictest = await strictestActiveRuleRole(companyId, documentType);
  if (strictest !== null && !mayWeakenAtLevel(actor.role, strictest)) {
    // No audit_log action fits a refusal, and withAuth commits a 4xx — so the
    // attempt to weaken the control is recorded here rather than not at all.
    log.warn('Approval enforcement disable refused', {
      companyId, documentType, actorId: actor.userId, actorRole: actor.role, strictestRuleRole: strictest,
    }, 'accounting');
    throw new ApprovalEnforcementAuthorityError(documentType, strictest);
  }
  const rows = (await sql`
    DELETE FROM approval_enforcement WHERE company_id = ${companyId} AND document_type = ${documentType}
    RETURNING *
  `) as Row[];
  if (!rows[0]) return;
  await auditEnforcement(companyId, actor, 'delete', rows[0], strictest ? { strictestRuleRole: strictest } : {});
  log.info('Approval enforcement disabled', { companyId, documentType }, 'accounting');
}
