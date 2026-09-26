/**
 * The blocking-exceptions gate for locking a VAT period and for manually
 * marking a VAT201 submission as submitted.
 *
 * getVatExceptions' `totalExceptions` (the recon, unposted invoice VAT, and
 * the older uncoded/mismatch/non-supply types — NOT unsupported input VAT,
 * which is visible but non-blocking per Hein, 2026-09-26: holding a tax
 * invoice is the vendor's legal responsibility and it may live outside
 * IsaFlow) is already an ABSOLUTE refusal for SARS ISV filing
 * (sarsEfilingSubmissionService.evaluateEfilingGate — no override, ISV stays
 * dark). This module gives the
 * SAME blocking count a narrow escape hatch for the two actions that record a
 * period as filed WITHOUT going through ISV: an owner or admin may proceed
 * with a non-empty reason, which is recorded (migration 704) and never
 * consulted by the ISV gate.
 *
 * The refusal MUST land before any write: callers run `assertVatGateClear`
 * before the lock INSERT / markSubmitted UPDATE, exactly like the existing
 * rateCheck/`ties` refusal on lock, which this does not replace — a period
 * failing SARS's 15% check is still refused (with its own `force:true`)
 * independently of whether blocking exceptions are overridden here. The two
 * checks are deliberately separate: force:true answers "is the arithmetic
 * self-consistent", an exceptions override answers "is this VAT actually
 * accounted for" — a period can fail either without failing the other, and
 * conflating them would let one flag silence a check about a different fact.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getVatExceptions } from './vatExceptionsService';
import type { VatExceptionsReport } from './vatExceptionsTypes';

export type VatGateTargetType = 'vat_period_lock' | 'sars_submission';

/** Owner/admin only — same threshold as unlockVatPeriod's route-level gate. */
const OVERRIDE_ROLES: readonly string[] = ['owner', 'admin', 'super_admin'];

export interface VatGateExceptionCounts {
  uncodedGlLineCount: number;
  invoiceTaxCodeIssueCount: number;
  invoiceGlMismatchCount: number;
  vatOnBalanceSheetCount: number;
  vatNonSupplyCount: number;
  unpostedInvoiceVatCount: number;
  unsupportedInputVatCount: number;
  totalExceptions: number;
}

export function vatGateExceptionCounts(report: VatExceptionsReport): VatGateExceptionCounts {
  return {
    uncodedGlLineCount: report.uncodedGlLineCount,
    invoiceTaxCodeIssueCount: report.invoiceTaxCodeIssueCount,
    invoiceGlMismatchCount: report.invoiceGlMismatchCount,
    vatOnBalanceSheetCount: report.vatOnBalanceSheetCount,
    vatNonSupplyCount: report.vatNonSupplyCount,
    unpostedInvoiceVatCount: report.unpostedInvoiceVatCount,
    unsupportedInputVatCount: report.unsupportedInputVatCount,
    totalExceptions: report.totalExceptions,
  };
}

/**
 * Blocking exceptions are present and no valid override was supplied. Maps to
 * 400 — pre-write. Message names only the caller's own exception counts, no
 * id/amount/table, so it is safe to surface verbatim (REFUSAL_CODES).
 */
export class VatGateBlockedError extends Error {
  readonly code = 'VAT_GATE_BLOCKED';
  readonly counts: VatGateExceptionCounts;
  constructor(counts: VatGateExceptionCounts) {
    super(
      `${counts.totalExceptions} blocking VAT exception${counts.totalExceptions === 1 ? '' : 's'} must be cleared `
      + 'before this can proceed (or overridden by an owner/admin with a reason).',
    );
    this.name = 'VatGateBlockedError';
    this.counts = counts;
  }
}

/**
 * An override reason was supplied by someone who is not owner/admin. Maps to
 * 403 — pre-write. Fixed sentence, names nothing caller-specific.
 */
export class VatGateOverrideForbiddenError extends Error {
  readonly code = 'VAT_GATE_OVERRIDE_FORBIDDEN';
  constructor() {
    super('Only an owner or admin can override blocking VAT exceptions.');
    this.name = 'VatGateOverrideForbiddenError';
  }
}

export interface VatGateActor {
  userId: string;
  role: string;
}

/**
 * The caller's role for this company, read fresh from company_users — for MCP
 * tools, which carry no role on their context (McpToolContext has no `role`
 * field; API routes already have `req.companyRole` from withAuth and should
 * use that instead of calling this). Null when the user has no membership row.
 */
export async function getCompanyRoleForUser(companyId: string, userId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT role FROM company_users WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::TEXT
  `) as DbRow[];
  return rows[0] ? String(rows[0].role) : null;
}

export interface VatGateCheckResult {
  overridden: boolean;
  counts: VatGateExceptionCounts;
}

/**
 * Refuse when blocking exceptions are present, unless the actor is an
 * owner/admin AND supplied a non-empty override reason — in which case the
 * override is recorded (never a bare pass-through) and the caller may write.
 *
 * Runs its own `getVatExceptions` query rather than reusing a caller's report
 * (e.g. computeVatLockFigures' rateCheck report is a different computation),
 * so the count checked here is always the one shown to the operator.
 */
export async function assertVatGateClear(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  targetType: VatGateTargetType,
  targetId: string | null,
  actor: VatGateActor,
  overrideReason: string | undefined,
): Promise<VatGateCheckResult> {
  const report = await getVatExceptions(companyId, periodStart, periodEnd);
  const counts = vatGateExceptionCounts(report);
  if (counts.totalExceptions === 0) {
    return { overridden: false, counts };
  }

  const reason = overrideReason?.trim();
  if (!reason) {
    throw new VatGateBlockedError(counts);
  }
  if (!OVERRIDE_ROLES.includes(actor.role)) {
    throw new VatGateOverrideForbiddenError();
  }

  await recordVatGateOverride(companyId, targetType, targetId, periodStart, periodEnd, actor.userId, reason, counts);
  return { overridden: true, counts };
}

async function recordVatGateOverride(
  companyId: string,
  targetType: VatGateTargetType,
  targetId: string | null,
  periodStart: string,
  periodEnd: string,
  actorUserId: string,
  reason: string,
  counts: VatGateExceptionCounts,
): Promise<void> {
  await sql`
    INSERT INTO vat_gate_overrides (
      company_id, target_type, target_id, period_start, period_end, actor, reason, exception_snapshot
    ) VALUES (
      ${companyId}::UUID, ${targetType}, ${targetId}::UUID, ${periodStart}::DATE, ${periodEnd}::DATE,
      ${actorUserId}::TEXT, ${reason}, ${JSON.stringify(counts)}::JSONB
    )
  `;
  log.info(
    'VAT gate override recorded',
    { companyId, targetType, targetId, periodStart, periodEnd, totalExceptions: counts.totalExceptions },
    'vatGateOverrideService',
  );
}

export interface VatGateOverrideRecord {
  id: string;
  targetType: VatGateTargetType;
  targetId: string | null;
  periodStart: string;
  periodEnd: string;
  actor: string;
  reason: string;
  exceptionSnapshot: VatGateExceptionCounts;
  createdAt: string;
}

function mapOverride(r: DbRow): VatGateOverrideRecord {
  return {
    id: String(r.id),
    targetType: r.target_type as VatGateTargetType,
    targetId: r.target_id == null ? null : String(r.target_id),
    periodStart: r.period_start instanceof Date ? r.period_start.toISOString().slice(0, 10) : String(r.period_start),
    periodEnd: r.period_end instanceof Date ? r.period_end.toISOString().slice(0, 10) : String(r.period_end),
    actor: String(r.actor),
    reason: String(r.reason),
    exceptionSnapshot: r.exception_snapshot as VatGateExceptionCounts,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** Every override recorded for a period, newest first — for display beside the lock/submission. */
export async function listVatGateOverrides(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VatGateOverrideRecord[]> {
  const rows = (await sql`
    SELECT id, target_type, target_id, period_start, period_end, actor, reason, exception_snapshot, created_at
    FROM vat_gate_overrides
    WHERE company_id = ${companyId}::UUID
      AND period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE
    ORDER BY created_at DESC
  `) as DbRow[];
  return rows.map(mapOverride);
}
