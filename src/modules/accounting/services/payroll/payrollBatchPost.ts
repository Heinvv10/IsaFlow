/**
 * Posting a payroll batch: each line becomes an assignment (payroll_employee_components) in the post's transaction,
 * under the company's payroll-approval lock. (Moved out of payrollBatchService.ts, which re-exports postBatch.)
 */
import { sql, withTransaction } from '@/lib/neon';
import type { TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertComponentInCompany } from './payrollEmployeeComponentService';
import { lockCompanyPayrollForComponentChange, paidPeriodsOf, type PaidPeriod } from './payrollComponentPaidMonths';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { refuseAssignmentWrite } from './payrollAssignmentWriteGuard';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { BatchNotEditableError, closeOnceOffAt, loadBatchForCompany, toDate, toDateOrNull, toIso, type Row } from './payrollBatchShared';

export async function postBatch(
  companyId: string,
  batchId: string,
  userId: string,
): Promise<{ inserted: number }> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // The company's payroll-approval lock first, held to the end, as approval, assign, End and Edit dates take it.
  return withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    return postBatchLocked(tx, companyId, batchId, userId);
  });
}

async function postBatchLocked(tx: TxSql, companyId: string, batchId: string, userId: string): Promise<{ inserted: number }> {
  // Each assignment is written and audited in the post's transaction (payrollComponentAudit).
  const paid = await paidPeriodsOf(tx, companyId, null); // once per post, not per line
  const write = (opts: AssignmentInsert) => insertAssignment(tx, companyId, { userId, channel: 'rest' }, opts, paid);
  const batch = await loadBatchForCompany(companyId, batchId);
  if (batch.status === 'posted' || batch.status === 'cancelled') {
    throw new BatchNotEditableError(batch.status);
  }
  if (batch.status !== 'validated') {
    throw new Error('Batch must be validated before posting');
  }

  const lines = (await sql`
    SELECT id, employee_id, value, km, rate_per_km,
           taxable_portion, non_taxable_portion,
           effective_from, effective_to
      FROM payroll_batch_lines
     WHERE batch_id = ${batchId}::uuid
  `) as Row[];

  let inserted = 0;

  if (batch.batchType === 'component_values') {
    const componentId = batch.componentId;
    if (!componentId) throw new Error('component_values batch missing componentId');
    // A batch stored before createBatch checked can still hold a foreign component.
    await assertComponentInCompany(componentId, companyId);
    for (const line of lines) {
      const effectiveFrom = toDate(line.effective_from);
      await write({
        employeeId: String(line.employee_id),
        componentId,
        amount: Number(line.value ?? 0),
        effectiveFrom,
        effectiveTo: closeOnceOffAt(batch, effectiveFrom, toDateOrNull(line.effective_to)),
        isRecurring: batch.isRecurring,
      });
      inserted += 1;
    }
  } else {
    const [taxableComponent, nonTaxableComponent] = await Promise.all([
      resolveTravelComponent(companyId, '3702'),
      resolveTravelComponent(companyId, '3703'),
    ]);

    for (const line of lines) {
      const taxable = Number(line.taxable_portion ?? 0);
      const nonTaxable = Number(line.non_taxable_portion ?? 0);
      const effectiveFrom = toDate(line.effective_from);
      const effectiveTo = closeOnceOffAt(batch, effectiveFrom, toDateOrNull(line.effective_to));

      if (taxable > 0) {
        await write({
          employeeId: String(line.employee_id),
          componentId: taxableComponent,
          amount: taxable,
          effectiveFrom,
          effectiveTo,
          isRecurring: batch.isRecurring,
        });
        inserted += 1;
      }
      if (nonTaxable > 0) {
        await write({
          employeeId: String(line.employee_id),
          componentId: nonTaxableComponent,
          amount: nonTaxable,
          effectiveFrom,
          effectiveTo,
          isRecurring: batch.isRecurring,
        });
        inserted += 1;
      }
    }
  }

  await sql`
    UPDATE payroll_batches
       SET status = 'posted',
           posted_at = NOW(),
           posted_by = ${userId},
           updated_at = NOW()
     WHERE id = ${batchId}::uuid AND company_id = ${companyId}::uuid
  `;

  log.info(
    'Payroll batch posted',
    { companyId, batchId, userId, inserted, batchType: batch.batchType },
    'payrollBatchService',
  );

  return { inserted };
}

async function resolveTravelComponent(companyId: string, sarsCode: '3702' | '3703'): Promise<string> {
  const rows = (await sql`
    SELECT id FROM payroll_components
     WHERE company_id = ${companyId}::uuid
       AND sars_source_code = ${sarsCode}
       AND is_active = true
     LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) {
    throw new Error(
      `Payroll component for SARS code ${sarsCode} not configured. Create it under Setup → Pay Components.`,
    );
  }
  return String(row.id);
}

interface AssignmentInsert {
  employeeId: string;
  componentId: string;
  amount: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isRecurring: boolean;
}

async function insertAssignment(
  tx: TxSql, companyId: string, actor: ComponentChangeActor, opts: AssignmentInsert, paid: PaidPeriod[],
): Promise<void> {
  const from = toIso(opts.effectiveFrom);
  const to = opts.effectiveTo ? toIso(opts.effectiveTo) : null;
  await refuseAssignmentWrite(tx, companyId, { employeeId: opts.employeeId, componentId: opts.componentId, from, to, recurring: opts.isRecurring }, { paid, named: true });
  const rows = (await tx`
    INSERT INTO payroll_employee_components (
      employee_id, component_id, amount, effective_from, effective_to, is_recurring, supersede_inferred
    ) VALUES (
      ${opts.employeeId}::uuid,
      ${opts.componentId}::uuid,
      ${opts.amount},
      ${from},
      ${to},
      ${opts.isRecurring},
      FALSE -- written by this release: superseded_at decides (migration 953)
    )
    RETURNING id
  `) as Row[];
  await auditComponentChange(tx, companyId, String(rows[0]!.id), null, { from, to, recurring: opts.isRecurring }, 'batch_assign', actor);
}
