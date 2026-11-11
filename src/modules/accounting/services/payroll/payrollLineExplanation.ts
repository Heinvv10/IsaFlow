/**
 * One run line's stored explanation (wave 5 EX-core, migration 973), for GET /api/payroll/runs/[id]/explanation.
 *
 * Read as stored: nothing is recomputed. A line with none says whether the run is final (approved or paid: its
 * figures will not be recalculated) and, for the message, when this company's lines began to carry explanations:
 * the earliest costed line that has one, read from the data, so the date is what the running code actually wrote
 * (not when a migration ran, which a blue/green build window or a code rollback would make untrue). A line costed
 * after that date without one was costed by code that did not record it; the UI says so instead of "before <date>".
 * Another company's run, a cancelled run, or an employee not on the run is not found.
 */
import { sql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import type { LineExplanations } from './payrollExplainTypes';

export class LineExplanationNotFound extends Error {
  constructor() {
    super('Pay run line not found');
    this.name = 'LineExplanationNotFound';
  }
}

export type LineExplanationRead =
  | { state: 'recorded'; final: boolean; explanations: LineExplanations }
  | { state: 'not_recorded'; final: boolean; costedAt: string | null; recordedFrom: string | null };

interface Row { explanation: unknown; status: string; costed_at: Date | string | null }

const FIGURES = ['paye', 'uif', 'sdl', 'eti'] as const;

/** The stored JSON is a schema-1 record with all four figures, each with a numeric result and an array of steps. */
export function isExplanations(v: unknown): v is LineExplanations {
  if (typeof v !== 'object' || v === null || (v as { schema?: unknown }).schema !== 1) return false;
  return FIGURES.every((f) => {
    const fig = (v as Record<string, unknown>)[f] as { steps?: unknown; result?: unknown } | null | undefined;
    return typeof fig === 'object' && fig !== null && Array.isArray(fig.steps) && typeof fig.result === 'number';
  });
}

const isoDate = (d: Date | string | null): string | null => {
  if (d === null) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** When this company's run lines began to carry explanations: the earliest costed line that has one (null: none yet). */
export async function explanationRecordedFrom(companyId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT MIN(l.created_at) AS first
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE h.company_id = ${companyId}::uuid AND l.explanation IS NOT NULL
  `) as Array<{ first: Date | string | null }>;
  return isoDate(rows[0]?.first ?? null);
}

export async function getLineExplanation(companyId: string, runId: string, employeeId: string): Promise<LineExplanationRead> {
  const rows = (await sql`
    SELECT l.explanation, h.status, l.created_at AS costed_at
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE l.run_id = ${runId}::uuid AND l.employee_id = ${employeeId}::uuid
       AND h.company_id = ${companyId}::uuid AND h.status <> 'cancelled'
  `) as Row[];
  const row = rows[0];
  if (!row) throw new LineExplanationNotFound();
  // Approved or paid: the stored figures stand (the payslip's DRAFT mark is a separate, approval-time question).
  const final = row.status === 'approved' || row.status === 'paid';
  if (isExplanations(row.explanation)) return { state: 'recorded', final, explanations: row.explanation };
  return { state: 'not_recorded', final, costedAt: isoDate(row.costed_at), recordedFrom: await explanationRecordedFrom(companyId) };
}

/** A Login-as read of an employee's payroll calculation, recorded as the payslip downloads are (auditPayslipDownload). */
export async function auditImpersonatedExplanationRead(d: {
  companyId: string; runId: string; employeeId: string; impersonatorUserId: string;
  actor: { userId: string; userEmail?: string; ip?: string; userAgent?: string; sessionId: string | null };
}): Promise<void> {
  await logAuditOrThrow({
    companyId: d.companyId, userId: d.actor.userId, userEmail: d.actor.userEmail, action: 'export',
    entityType: 'payroll_explanation', entityId: d.runId,
    changes: { fields: [], metadata: { runId: d.runId, employeeIds: d.employeeId, impersonated: 'true', impersonatorUserId: d.impersonatorUserId } },
    ip: d.actor.ip, userAgent: d.actor.userAgent, sessionId: d.actor.sessionId ?? undefined,
  });
}
