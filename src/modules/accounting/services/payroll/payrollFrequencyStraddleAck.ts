/**
 * Acknowledging a pay-frequency change's straddle on a run (wave 6 FQd, breaker #1622 M2; payrollFrequencyStraddle).
 * The employer settles the days paid twice or left unpaid with a once-off adjustment, then an owner or admin, in their
 * own session (the route refuses Login-as and agents), acknowledges them for this run and employee. The record is one
 * audit_log row (append-only for the app) carrying the exact days, so only those days are cleared.
 * Refused (StraddleAckRefused, 409) before any write: a run that is not regular, or not draft or calculated (approved
 * runs are history), or an employee with no unacknowledged straddle on it. Under the company's payroll-approval lock
 * and the run's row lock, as calculate and approve take them.
 */
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, PayrollRunNotFoundError } from './payrollRunLock';
import { dateColumnOf } from './payrollFrequency';
import { frequencyStraddles, STRADDLE_ENTITY, type FrequencyStraddle } from './payrollFrequencyStraddle';
import { payrollRunReadDate } from './payrollRunReadDate';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export class StraddleAckRefused extends Error {
  readonly code = 'FREQUENCY_STRADDLE_ACK_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'StraddleAckRefused';
  }
}

/** The run's dates and frequency as the straddle reads them; throws PayrollRunNotFoundError. */
function runOf(row: Record<string, unknown>, runId: string) {
  const year = Number(row.period_year);
  const month = Number(row.period_month);
  const start = dateColumnOf(row.period_start) ?? `${year}-${String(month).padStart(2, '0')}-01`;
  const end = dateColumnOf(row.period_end) ?? payrollRunReadDate({ year, month });
  return { id: runId, frequency: String(row.pay_frequency), start, end };
}

/** The run's straddles, acknowledged or not (the run page lists them). */
export async function listRunStraddles(companyId: string, runId: string, employeeIds: string[], row: Record<string, unknown>): Promise<FrequencyStraddle[]> {
  if (row.run_kind !== 'regular') return [];
  return frequencyStraddles(companyId, runOf(row, runId), employeeIds);
}

export async function acknowledgeFrequencyStraddle(
  companyId: string, runId: string, employeeId: string, actor: EmployeeEmailActor,
): Promise<FrequencyStraddle> {
  await lockCompanyPayrollApprovals(runId, companyId);
  const row = await lockPayrollRunHeader(runId, companyId);
  if (!row) throw new PayrollRunNotFoundError();
  if (row.run_kind !== 'regular') throw new StraddleAckRefused('Only a regular run starts a new pay frequency.');
  if (row.status !== 'draft' && row.status !== 'calculated') {
    throw new StraddleAckRefused(`This run is ${String(row.status)}: a frequency change is acknowledged before approval.`);
  }
  const run = runOf(row, runId);
  const found = (await frequencyStraddles(companyId, run, [employeeId])).find((s) => s.kind === 'straddle' && !s.acknowledged);
  if (!found) throw new StraddleAckRefused('This employee has no pay-frequency change to acknowledge on this run.');
  const days = found.overlap ? `paid twice ${found.overlap.from} to ${found.overlap.to}` : `unpaid ${found.gap!.from} to ${found.gap!.to}`;
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'approve', entityType: STRADDLE_ENTITY, entityId: runId,
    changes: {
      fields: [{ field: 'pay_frequency_change', old: found.oldFrequency, new: run.frequency, label: `Pay frequency change acknowledged (${days})` }],
      metadata: { employeeId, oldEnd: found.oldEnd, start: run.start, end: run.end, days },
    },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  return { ...found, acknowledged: true };
}
