/**
 * The audit row every writer of payroll_employee_components leaves (security review, 2026-11-02): Edit dates, End and
 * cancel (payrollComponentDateEdit), assign (payrollEmployeeComponentService), package apply, for each row it cuts and
 * each it inserts (payPackageService), batch post (payrollBatchService), and the pay-run grid (payrollRunPeriodInputs). Written in the writer's own transaction,
 * so the change and its record commit or roll back together; the approval gate reads these rows to refuse a run
 * calculated before them (payrollRunRecalcGate). Dates and ids only: never the amount (an employee's pay).
 */
import type { TxSql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import type { AssignmentWindow } from './payrollComponentPaidMonths';

export interface ComponentChangeActor { userId: string; userEmail?: string; channel: 'rest' | 'mcp' | 'service' }

export type ComponentChangeKind = 'edit' | 'end' | 'cancel' | 'assign' | 'package_assign' | 'package_supersede' | 'batch_assign'
  // The pay-run grid's once-off for its run month (payrollRunPeriodInputs): set or changed, and removed (amount nil).
  | 'run_input' | 'run_input_remove';

export async function auditComponentChange(
  tx: TxSql,
  companyId: string,
  assignmentId: string,
  before: AssignmentWindow | null,
  after: AssignmentWindow,
  kind: ComponentChangeKind,
  actor: ComponentChangeActor,
  /** The package a package_assign row came from: what makes the once-off the package's own on a re-apply. */
  extra: { packageId?: string } = {},
): Promise<void> {
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: before ? 'update' : 'create',
    entityType: 'payroll_employee_component', entityId: assignmentId,
    // After the company lock, so audit rows order with calculated_at as the lock orders the work (payrollRunRecalcGate).
    atClockTime: true,
    changes: {
      fields: [
        { field: 'effective_from', old: before?.from ?? null, new: after.from, label: 'Effective from' },
        { field: 'effective_to', old: before?.to ?? null, new: after.to, label: 'Effective to' },
      ],
      metadata: { kind, channel: actor.channel, recurring: String(after.recurring), ...(extra.packageId ? { packageId: extra.packageId } : {}) },
    },
  }, tx);
}
