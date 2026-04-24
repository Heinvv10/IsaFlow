/**
 * Bulk Search & Replace for payroll employees (VIP parity).
 *
 * A filter narrows the working set; an update sets one or more tracked
 * fields on every matching row. Both preview and apply are computed from
 * the same filter SQL so the operator sees exactly what will change.
 *
 * Tracked fields (also the ones that write to payroll_employee_history):
 *   - department        (VARCHAR)
 *   - cost_centre_id    (UUID — writes the UUID as text for audit)
 *   - employment_type   (VARCHAR)
 *
 * Apply runs inside a single BEGIN/COMMIT: the UPDATE and the history
 * inserts always commit together or not at all.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { recordEmployeeChange } from './payrollEmployeeHistoryService';

export interface BulkFilter {
  department?: string | null;
  costCentreId?: string | null;
  employmentType?: string | null;
}

export interface BulkUpdate {
  department?: string;
  costCentreId?: string | null;
  employmentType?: string;
}

export interface BulkPreviewRow {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  changes: {
    department?: { from: string | null; to: string };
    costCentreId?: { from: string | null; to: string | null };
    employmentType?: { from: string | null; to: string };
  };
}

export interface BulkPreview {
  matchCount: number;
  sample: BulkPreviewRow[];
}

export interface BulkApplyOptions {
  effectiveFrom?: string;
  changeReason?: string;
}

export interface BulkApplyResult {
  updated: number;
}

export class EmptyUpdateError extends Error {
  constructor() {
    super('At least one field must be supplied in the update');
    this.name = 'EmptyUpdateError';
  }
}

export class EmptyFilterError extends Error {
  constructor() {
    super('At least one filter criterion is required');
    this.name = 'EmptyFilterError';
  }
}

function hasAnyFilter(f: BulkFilter): boolean {
  return f.department !== undefined || f.costCentreId !== undefined || f.employmentType !== undefined;
}

function hasAnyUpdate(u: BulkUpdate): boolean {
  return u.department !== undefined || u.costCentreId !== undefined || u.employmentType !== undefined;
}

async function findMatchingEmployees(
  companyId: string,
  filter: BulkFilter,
): Promise<DbRow[]> {
  return (await sql`
    SELECT id, employee_number, first_name, last_name, department, cost_centre_id, employment_type
      FROM payroll_employees
     WHERE company_id = ${companyId}::uuid
       AND status = 'active'
       AND (${filter.department ?? null}::text IS NULL OR department = ${filter.department ?? null})
       AND (${filter.costCentreId ?? null}::uuid IS NULL OR cost_centre_id = ${filter.costCentreId ?? null}::uuid)
       AND (${filter.employmentType ?? null}::text IS NULL OR employment_type = ${filter.employmentType ?? null})
     ORDER BY last_name, first_name
  `) as DbRow[];
}

function buildChanges(row: DbRow, update: BulkUpdate): BulkPreviewRow['changes'] {
  const c: BulkPreviewRow['changes'] = {};
  if (update.department !== undefined) {
    c.department = { from: row.department == null ? null : String(row.department), to: update.department };
  }
  if (update.costCentreId !== undefined) {
    c.costCentreId = {
      from: row.cost_centre_id == null ? null : String(row.cost_centre_id),
      to: update.costCentreId,
    };
  }
  if (update.employmentType !== undefined) {
    c.employmentType = {
      from: row.employment_type == null ? null : String(row.employment_type),
      to: update.employmentType,
    };
  }
  return c;
}

export async function previewBulkEmployeeUpdate(
  companyId: string,
  filter: BulkFilter,
  update: BulkUpdate,
  sampleLimit = 50,
): Promise<BulkPreview> {
  if (!hasAnyUpdate(update)) throw new EmptyUpdateError();
  if (!hasAnyFilter(filter)) throw new EmptyFilterError();

  const rows = await findMatchingEmployees(companyId, filter);
  const sample: BulkPreviewRow[] = rows.slice(0, sampleLimit).map(r => ({
    id: String(r.id),
    employeeNumber: String(r.employee_number),
    firstName: String(r.first_name),
    lastName: String(r.last_name),
    changes: buildChanges(r, update),
  }));
  return { matchCount: rows.length, sample };
}

export async function applyBulkEmployeeUpdate(
  companyId: string,
  filter: BulkFilter,
  update: BulkUpdate,
  userId: string,
  opts: BulkApplyOptions = {},
): Promise<BulkApplyResult> {
  if (!hasAnyUpdate(update)) throw new EmptyUpdateError();
  if (!hasAnyFilter(filter)) throw new EmptyFilterError();

  const rows = await findMatchingEmployees(companyId, filter);
  if (rows.length === 0) return { updated: 0 };

  log.info(
    'Applying bulk employee update',
    { companyId, userId, matchCount: rows.length, update },
    'payrollBulkEmployeeService',
  );

  await sql`BEGIN`;
  try {
    for (const r of rows) {
      const id = String(r.id);
      await sql`
        UPDATE payroll_employees SET
          department      = COALESCE(${update.department ?? null}::text, department),
          cost_centre_id  = CASE
                              WHEN ${update.costCentreId === undefined}::boolean THEN cost_centre_id
                              ELSE ${update.costCentreId ?? null}::uuid
                            END,
          employment_type = COALESCE(${update.employmentType ?? null}::text, employment_type),
          updated_at      = NOW()
        WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      `;

      if (update.department !== undefined) {
        await recordEmployeeChange({
          companyId,
          employeeId: id,
          fieldName: 'department',
          oldValue: r.department == null ? null : String(r.department),
          newValue: update.department,
          userId,
          ...(opts.effectiveFrom !== undefined && { effectiveFrom: opts.effectiveFrom }),
          ...(opts.changeReason !== undefined && { changeReason: opts.changeReason }),
        });
      }
      if (update.costCentreId !== undefined) {
        await recordEmployeeChange({
          companyId,
          employeeId: id,
          fieldName: 'cost_centre_id',
          oldValue: r.cost_centre_id == null ? null : String(r.cost_centre_id),
          newValue: update.costCentreId,
          userId,
          ...(opts.effectiveFrom !== undefined && { effectiveFrom: opts.effectiveFrom }),
          ...(opts.changeReason !== undefined && { changeReason: opts.changeReason }),
        });
      }
      if (update.employmentType !== undefined) {
        await recordEmployeeChange({
          companyId,
          employeeId: id,
          fieldName: 'employment_type',
          oldValue: r.employment_type == null ? null : String(r.employment_type),
          newValue: update.employmentType,
          userId,
          ...(opts.effectiveFrom !== undefined && { effectiveFrom: opts.effectiveFrom }),
          ...(opts.changeReason !== undefined && { changeReason: opts.changeReason }),
        });
      }
    }
    await sql`COMMIT`;
    return { updated: rows.length };
  } catch (err) {
    await sql`ROLLBACK`;
    throw err;
  }
}
