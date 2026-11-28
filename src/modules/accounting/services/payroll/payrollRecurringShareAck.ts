/**
 * W29 (wave 7 PRA; review #1901 M2, coordinator decision A): a line that pays a recurring earning its share beside a
 * once-off earning (RECURRING_SHARE_BESIDE_ONCE_OFF, payrollRecurringShare.shareBesideOnceOffResults) may pay the same days
 * twice, when the once-off was a hand pro-rata the old guard asked for. Approval is refused (`recurring_share_beside_once_off`,
 * via payrollRecurringProRata.runProRataBlocker) until an owner or admin, in their own session (the route refuses Login-as
 * and agents), acknowledges each such employee on the run. The pattern is wave 6 FQd's frequency-change acknowledgement
 * (payrollFrequencyStraddleAck): one audit_log row (append-only for the app), entity SHARE_ACK_ENTITY, the run's id, with
 * the employee and the line's `pairKey` (the rows and amounts). A recalculation that changes either side writes a new key,
 * and the old acknowledgement no longer matches. An acknowledgement is read back only for a run of this company (joined to
 * payroll_run_headers) and an employee of this company.
 * Refused (RecurringShareAckRefused, 409) before any write: a run not draft or calculated, or an employee with no
 * unacknowledged pair on the run's stored line. Under the company's payroll-approval lock and the run's row lock.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, PayrollRunNotFoundError } from './payrollRunLock';
import { SHARE_BESIDE_ONCE_OFF } from './payrollRecurringShare';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export const SHARE_ACK_ENTITY = 'recurring_share_ack';

export class RecurringShareAckRefused extends Error {
  readonly code = 'RECURRING_SHARE_ACK_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'RecurringShareAckRefused';
  }
}

export interface RunSharePair { employeeId: string; employeeNumber: string; employeeName: string; message: string; pairKey: string; acknowledged: boolean }

/** Each employee of the run whose stored line pairs a share with a once-off earning, and whether that pair is acknowledged. */
export async function listRunSharePairs(companyId: string, runId: string): Promise<RunSharePair[]> {
  const lines = (await sql`
    SELECT l.employee_id::text AS employee_id, e.employee_number, e.first_name, e.last_name, v->>'pairKey' AS pair_key, v->>'message' AS message
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = ${companyId}::uuid
      CROSS JOIN LATERAL jsonb_path_query(l.validation_results, ${`$[*] ? (@.code == "${SHARE_BESIDE_ONCE_OFF}")`}::jsonpath) AS v
     WHERE l.run_id = ${runId}::uuid
     ORDER BY e.employee_number
  `) as DbRow[];
  if (lines.length === 0) return [];
  const acks = (await sql`
    SELECT a.changes->'metadata'->>'employeeId' AS employee_id, a.changes->'metadata'->>'pairKey' AS pair_key
      FROM audit_log a
      JOIN payroll_run_headers h ON h.id = a.entity_id AND h.company_id = ${companyId}::uuid
     WHERE a.company_id = ${companyId}::uuid AND a.entity_type = ${SHARE_ACK_ENTITY} AND a.entity_id = ${runId}::uuid
  `) as DbRow[];
  const acked = new Set(acks.map((a) => `${String(a.employee_id)}|${String(a.pair_key)}`));
  return lines.map((l) => ({
    employeeId: String(l.employee_id), employeeNumber: String(l.employee_number),
    employeeName: `${String(l.first_name ?? '')} ${String(l.last_name ?? '')}`.trim(),
    message: String(l.message), pairKey: String(l.pair_key), acknowledged: acked.has(`${String(l.employee_id)}|${String(l.pair_key)}`),
  }));
}

/** The approval refusal while any pair on the run is not acknowledged, or null. Read-only. */
export async function runShareAckBlocker(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const open = (await listRunSharePairs(companyId, runId)).filter((p) => !p.acknowledged);
  if (open.length === 0) return null;
  return {
    code: 'recurring_share_beside_once_off',
    detail: 'A recurring earning that started or ended inside employment is paid its share of the period beside a once-off earning '
      + `for ${open.map((p) => p.employeeNumber).join(', ')}. If a once-off was a hand pro-rata of the same days, those days are paid twice: `
      + 'end or reduce it and recalculate. Otherwise an owner or admin acknowledges each employee on the run page.',
  };
}

export async function acknowledgeRecurringShare(
  companyId: string, runId: string, employeeId: string, actor: EmployeeEmailActor,
): Promise<RunSharePair> {
  await lockCompanyPayrollApprovals(runId, companyId);
  const row = await lockPayrollRunHeader(runId, companyId);
  if (!row) throw new PayrollRunNotFoundError();
  if (row.status !== 'draft' && row.status !== 'calculated') {
    throw new RecurringShareAckRefused(`This run is ${String(row.status)}: a share beside a once-off is acknowledged before approval.`);
  }
  const found = (await listRunSharePairs(companyId, runId)).find((p) => p.employeeId === employeeId && !p.acknowledged);
  if (!found) throw new RecurringShareAckRefused('This employee has no share beside a once-off to acknowledge on this run.');
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'approve', entityType: SHARE_ACK_ENTITY, entityId: runId,
    changes: {
      fields: [{ field: 'recurring_share_beside_once_off', old: null, new: 'acknowledged', label: 'Share beside a once-off acknowledged' }],
      metadata: { employeeId, pairKey: found.pairKey },
    },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  return { ...found, acknowledged: true };
}
