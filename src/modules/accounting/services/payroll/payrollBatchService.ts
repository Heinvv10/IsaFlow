/**
 * Payroll batch transactions — VIP-style "Batch Transactions" and
 * "Reimbursive Travel Transaction Batch" equivalents.
 *
 * Lifecycle: draft → validated → posted. A posted batch is immutable; the
 * only forward path from a broken post is to create a new batch.
 *
 * component_values: one component across many employees (e.g. overtime, bonus).
 * reimbursive_travel: per-employee km + rate, split into SARS 3702 (taxable)
 * and 3703 (non-taxable) component rows on post.
 */

import { sql } from '@/lib/neon';
import {executeCompensationCaller,type CompensationExecutionOptions} from '../controls/payrollCompensationLegacyAdapter';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export type {BatchType,BatchStatus,PayrollBatch,PayrollBatchLine,CreateBatchInput,BatchLineInput} from './payrollBatchModel';
export {BatchNotFoundError,BatchNotEditableError} from './payrollBatchModel';
import {BatchNotFoundError,BatchNotEditableError,mapBatch,mapLine,toIso,assertEditable,deriveLineValue,type BatchType,type BatchStatus,type PayrollBatch,type PayrollBatchLine,type CreateBatchInput,type BatchLineInput} from './payrollBatchModel';

async function loadBatchForCompany(companyId: string, batchId: string): Promise<PayrollBatch> {
  const rows = (await sql`
    SELECT * FROM payroll_batches
     WHERE id = ${batchId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) throw new BatchNotFoundError(batchId);
  return mapBatch(row);
}


export async function createBatch(input: CreateBatchInput): Promise<PayrollBatch> {
  if (input.periodMonth < 1 || input.periodMonth > 12) {
    throw new Error('period_month must be between 1 and 12');
  }
  if (input.batchType === 'component_values' && !input.componentId) {
    throw new Error('componentId is required for component_values batches');
  }
  if (!input.description.trim()) {
    throw new Error('description is required');
  }

  log.info(
    'Creating payroll batch',
    {
      companyId: input.companyId,
      batchType: input.batchType,
      componentId: input.componentId,
      periodYear: input.periodYear,
      periodMonth: input.periodMonth,
    },
    'payrollBatchService',
  );

  const rows = (await sql`
    INSERT INTO payroll_batches (
      company_id, batch_type, component_id, description,
      period_year, period_month, is_recurring, notes, created_by
    ) VALUES (
      ${input.companyId}::uuid,
      ${input.batchType},
      ${input.componentId ?? null},
      ${input.description.trim()},
      ${input.periodYear},
      ${input.periodMonth},
      ${input.isRecurring ?? false},
      ${input.notes ?? null},
      ${input.userId}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapBatch(rows[0]);
}

async function assertEmployeesInCompany(companyId: string, employeeIds: string[]): Promise<void> {
  if (employeeIds.length === 0) return;
  const rows = (await sql`
    SELECT id FROM payroll_employees
     WHERE company_id = ${companyId}::uuid
       AND id = ANY(${employeeIds}::uuid[])
  `) as Row[];
  const found = new Set(rows.map(r => String(r.id)));
  const missing = employeeIds.filter(id => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Employees not in company: ${missing.join(', ')}`);
  }
}

async function refreshBatchTotals(batchId: string): Promise<void> {
  await sql`
    UPDATE payroll_batches
       SET line_count = COALESCE((
             SELECT COUNT(*) FROM payroll_batch_lines WHERE batch_id = ${batchId}::uuid
           ), 0),
           total_amount = COALESCE((
             SELECT SUM(value) FROM payroll_batch_lines WHERE batch_id = ${batchId}::uuid
           ), 0),
           updated_at = NOW()
     WHERE id = ${batchId}::uuid
  `;
}

export async function addBatchLines(
  companyId: string,
  batchId: string,
  lines: BatchLineInput[],
): Promise<{ inserted: number }> {
  const batch = await loadBatchForCompany(companyId, batchId);
  assertEditable(batch);

  if (lines.length === 0) return { inserted: 0 };

  await assertEmployeesInCompany(
    companyId,
    lines.map(l => l.employeeId),
  );

  let inserted = 0;
  for (const line of lines) {
    const value = deriveLineValue(batch.batchType, line);
    const km = line.km ?? null;
    const rate = line.ratePerKm ?? null;
    const taxable = line.taxablePortion ?? null;
    const nonTaxable = line.nonTaxablePortion ?? null;

    await sql`
      INSERT INTO payroll_batch_lines (
        batch_id, employee_id, value, km, rate_per_km,
        taxable_portion, non_taxable_portion,
        effective_from, effective_to, notes
      ) VALUES (
        ${batchId}::uuid,
        ${line.employeeId}::uuid,
        ${value},
        ${km},
        ${rate},
        ${taxable},
        ${nonTaxable},
        ${toIso(line.effectiveFrom)},
        ${line.effectiveTo ? toIso(line.effectiveTo) : null},
        ${line.notes ?? null}
      )
      ON CONFLICT (batch_id, employee_id) DO UPDATE SET
        value = EXCLUDED.value,
        km = EXCLUDED.km,
        rate_per_km = EXCLUDED.rate_per_km,
        taxable_portion = EXCLUDED.taxable_portion,
        non_taxable_portion = EXCLUDED.non_taxable_portion,
        effective_from = EXCLUDED.effective_from,
        effective_to = EXCLUDED.effective_to,
        notes = EXCLUDED.notes,
        error = NULL
    `;
    inserted += 1;
  }

  await refreshBatchTotals(batchId);
  return { inserted };
}


export interface ValidateResult {
  ok: boolean;
  errors: Array<{ lineId: string; employeeId: string; error: string }>;
  totalLines: number;
}

export async function validateBatch(companyId: string, batchId: string): Promise<ValidateResult> {
  const batch = await loadBatchForCompany(companyId, batchId);
  assertEditable(batch);

  const lines = (await sql`
    SELECT bl.id, bl.employee_id, bl.value, bl.km, bl.rate_per_km,
           e.status AS employee_status
      FROM payroll_batch_lines bl
      JOIN payroll_employees e ON e.id = bl.employee_id
     WHERE bl.batch_id = ${batchId}::uuid
  `) as Row[];

  const errors: ValidateResult['errors'] = [];
  for (const line of lines) {
    const problem = detectLineProblem(batch.batchType, line);
    if (problem) {
      errors.push({
        lineId: String(line.id),
        employeeId: String(line.employee_id),
        error: problem,
      });
      await sql`
        UPDATE payroll_batch_lines SET error = ${problem}
         WHERE id = ${String(line.id)}::uuid
      `;
    } else {
      await sql`
        UPDATE payroll_batch_lines SET error = NULL
         WHERE id = ${String(line.id)}::uuid
      `;
    }
  }

  const newStatus: BatchStatus = errors.length === 0 ? 'validated' : 'draft';
  await sql`
    UPDATE payroll_batches
       SET status = ${newStatus}, updated_at = NOW()
     WHERE id = ${batchId}::uuid
  `;

  return { ok: errors.length === 0, errors, totalLines: lines.length };
}

function detectLineProblem(batchType: BatchType, line: Row): string | null {
  const status = String(line.employee_status ?? '');
  if (status === 'terminated') return 'Employee is terminated';
  if (status === 'inactive') return 'Employee is inactive';

  if (batchType === 'reimbursive_travel') {
    const km = line.km == null ? null : Number(line.km);
    const rate = line.rate_per_km == null ? null : Number(line.rate_per_km);
    if (km == null || km <= 0) return 'km must be > 0';
    if (rate == null || rate <= 0) return 'rate_per_km must be > 0';
    return null;
  }

  const value = Number(line.value ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 'value must be > 0';
  return null;
}

export async function postBatch(
  companyId: string,
  batchId: string,
  userId: string,
  options: CompensationExecutionOptions = {},
): Promise<{ inserted: number }> {
  const result=await executeCompensationCaller(companyId,{version:1,source:{kind:'batch',sourceId:batchId}},options,userId);
  return{inserted:result.inserted};
}

export async function deleteBatch(companyId: string, batchId: string): Promise<void> {
  const batch = await loadBatchForCompany(companyId, batchId);
  assertEditable(batch);
  await sql`
    DELETE FROM payroll_batches
     WHERE id = ${batchId}::uuid AND company_id = ${companyId}::uuid
  `;
}

export async function cancelBatch(companyId: string, batchId: string): Promise<void> {
  const batch = await loadBatchForCompany(companyId, batchId);
  if (batch.status === 'posted') throw new BatchNotEditableError('posted');
  await sql`
    UPDATE payroll_batches
       SET status = 'cancelled', updated_at = NOW()
     WHERE id = ${batchId}::uuid AND company_id = ${companyId}::uuid
  `;
}

export interface ListBatchesOptions {
  status?: BatchStatus;
  batchType?: BatchType;
  periodYear?: number;
  periodMonth?: number;
}

export async function listBatches(companyId: string, opts: ListBatchesOptions = {}): Promise<PayrollBatch[]> {
  const rows = (await sql`
    SELECT * FROM payroll_batches
     WHERE company_id = ${companyId}::uuid
       AND (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null}::text)
       AND (${opts.batchType ?? null}::text IS NULL OR batch_type = ${opts.batchType ?? null}::text)
       AND (${opts.periodYear ?? null}::integer IS NULL OR period_year = ${opts.periodYear ?? null}::integer)
       AND (${opts.periodMonth ?? null}::integer IS NULL OR period_month = ${opts.periodMonth ?? null}::integer)
     ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapBatch);
}

export async function getBatch(
  companyId: string,
  batchId: string,
): Promise<{ batch: PayrollBatch; lines: PayrollBatchLine[] }> {
  const batch = await loadBatchForCompany(companyId, batchId);

  const lines = (await sql`
    SELECT bl.*,
           (e.first_name || ' ' || e.last_name) AS employee_name,
           e.employee_number AS employee_number
      FROM payroll_batch_lines bl
      JOIN payroll_employees e ON e.id = bl.employee_id AND e.company_id = ${companyId}::uuid
     WHERE bl.batch_id = ${batchId}::uuid
     ORDER BY e.employee_number
  `) as Row[];

  return { batch, lines: lines.map(mapLine) };
}
