/**
 * The audit row every writer of payroll_employee_components leaves (security review, 2026-11-02): Edit dates, End and
 * cancel (payrollComponentDateEdit), assign (payrollEmployeeComponentService), package apply, for each row it cuts and
 * each it inserts (payPackageService), and batch post (payrollBatchService). Written in the writer's own transaction,
 * so the change and its record commit or roll back together; the approval gate reads these rows to refuse a run
 * calculated before them (payrollRunRecalcGate). Dates and ids only: never the amount (an employee's pay).
 */
import type { TxSql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import type { AssignmentWindow } from './payrollComponentPaidMonths';

export interface ComponentChangeActor { userId: string; userEmail?: string; channel: 'rest' | 'mcp' | 'service' }

export type ComponentChangeKind = 'edit' | 'end' | 'cancel' | 'assign' | 'package_assign' | 'package_supersede' | 'batch_assign';

export async function auditComponentChange(
  tx: TxSql,
  companyId: string,
  assignmentId: string,
  before: AssignmentWindow | null,
  after: AssignmentWindow,
  kind: ComponentChangeKind,
  actor: ComponentChangeActor,
): Promise<void> {
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: before ? 'update' : 'create',
    entityType: 'payroll_employee_component', entityId: assignmentId,
    changes: {
      fields: [
        { field: 'effective_from', old: before?.from ?? null, new: after.from, label: 'Effective from' },
        { field: 'effective_to', old: before?.to ?? null, new: after.to, label: 'Effective to' },
      ],
      metadata: { kind, channel: actor.channel, recurring: String(after.recurring) },
    },
  }, tx);
}
