/**
 * Cost Centre Service — GL analysis codes (cc1/cc2) + payroll HR assignment.
 *
 * Accounting GL cost centres use cc_type to distinguish cc1 vs cc2 dimensions.
 * Payroll cost centres track per-employee assignment and run-level roll-ups.
 * The payroll_employees.cost_centre_id FK (mig 450, made RESTRICT by mig 649)
 * is the single source of truth for HR cost allocation; a run's roll-up by it is
 * payroll/costCentreRunSummary. Delete eligibility: costCentreUsageGuard.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { recordEmployeeChange } from '../payroll/payrollEmployeeHistoryService';
import { assertCostCentreUnused, cannotDeleteMessage, CostCentreActionError, FK_VIOLATION } from './costCentreUsageGuard';
import { lockDimensionMasters } from './dimensionMasterLock';

// ── GL / Accounting cost centre types ─────────────────────────────────────────

export type CcType = 'cc1' | 'cc2';

export interface CostCentre {
  id: string;
  code: string;
  name: string;
  description?: string;
  department?: string;
  ccType: CcType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function getCostCentres(companyId: string, activeOnly = false, ccType?: CcType): Promise<CostCentre[]> {
  let rows: DbRow[];
  if (ccType && activeOnly) {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} AND cc_type = ${ccType} AND is_active = true ORDER BY code`) as Record<string, unknown>[];
  } else if (ccType) {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} AND cc_type = ${ccType} ORDER BY code`) as Record<string, unknown>[];
  } else if (activeOnly) {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} AND is_active = true ORDER BY code`) as Record<string, unknown>[];
  } else {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} ORDER BY code`) as Record<string, unknown>[];
  }
  return rows.map(mapGlRow);
}

export async function deleteCostCentre(companyId: string, id: string): Promise<void> {
  await lockDimensionMasters(companyId);
  await assertCostCentreUnused(companyId, id);
  let deleted: Record<string, unknown>[];
  try {
    // Its own savepoint: a 23503 here would otherwise abort the request
    // transaction, and the refusal below could not be answered or audited.
    deleted = await withSavepoint('cost_centre_delete', async () =>
      (await sql`DELETE FROM cost_centres WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING id`) as Record<string, unknown>[]);
  } catch (err) {
    // Guard is tenant-scoped, the RESTRICT FKs are not: another company's row
    // is invisible above and reaches us as a 23503 — as does a line written
    // between the count and the DELETE (migrations 878, 882).
    if ((err as { code?: string }).code === FK_VIOLATION) throw new CostCentreActionError(cannotDeleteMessage([]));
    throw err;
  }
  // A scoped DELETE that matched nothing is another tenant's id, or an id that
  // is already gone; either way reporting success is a lie.
  if (deleted.length === 0) throw new CostCentreActionError(`Cost centre not found: ${id}`);
}

function mapGlRow(row: Record<string, unknown>): CostCentre {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    department: row.department ? String(row.department) : undefined,
    ccType: (row.cc_type || 'cc1') as CcType,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── Payroll cost centre types ──────────────────────────────────────────────────

export interface PayrollCostCentre {
  id: string;
  companyId: string;
  code: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class CostCentreNotFoundError extends Error {
  constructor(id: string) {
    super(`Cost centre ${id} not found`);
    this.name = 'CostCentreNotFoundError';
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapPayrollRow(r: Record<string, unknown>): PayrollCostCentre {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    code: String(r.code),
    name: String(r.name),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    isActive: r.is_active === true,
    notes: r.notes == null ? null : String(r.notes),
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export interface ListCostCentresOptions {
  activeOnly?: boolean;
}

export async function listCostCentres(
  companyId: string,
  opts: ListCostCentresOptions = {},
): Promise<PayrollCostCentre[]> {
  const rows = (
    opts.activeOnly
      ? await sql`
          SELECT * FROM cost_centres
           WHERE company_id = ${companyId}::uuid
             AND is_active = true
           ORDER BY code
        `
      : await sql`
          SELECT * FROM cost_centres
           WHERE company_id = ${companyId}::uuid
           ORDER BY code
        `
  ) as Record<string, unknown>[];
  return rows.map(mapPayrollRow);
}

async function assertCostCentreInCompany(companyId: string, costCentreId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM cost_centres
     WHERE id = ${costCentreId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Record<string, unknown>[];
  if (rows.length === 0) throw new CostCentreNotFoundError(costCentreId);
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Record<string, unknown>[];
  if (rows.length === 0) throw new Error(`Employee ${employeeId} not in company`);
}

/** One cost centre in the payroll shape; null when it is not this company's. */
export async function getPayrollCostCentre(companyId: string, id: string): Promise<PayrollCostCentre | null> {
  const rows = (await sql`
    SELECT * FROM cost_centres WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Record<string, unknown>[];
  return rows[0] ? mapPayrollRow(rows[0]) : null;
}

export async function assignEmployeeCostCentre(
  companyId: string,
  employeeId: string,
  costCentreId: string | null,
  userId?: string,
): Promise<void> {
  await assertEmployeeInCompany(companyId, employeeId);
  if (costCentreId !== null) {
    await assertCostCentreInCompany(companyId, costCentreId);
  }

  const beforeRows = (await sql`
    SELECT cost_centre_id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Record<string, unknown>[];
  const oldValue = beforeRows[0]?.cost_centre_id == null ? null : String(beforeRows[0]!.cost_centre_id);

  await sql`
    UPDATE payroll_employees
       SET cost_centre_id = ${costCentreId}::uuid,
           updated_at = NOW()
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `;
  log.info('Employee cost centre reassigned', { companyId, employeeId, costCentreId }, 'costCentreService');

  if (userId) {
    await recordEmployeeChange({
      companyId,
      employeeId,
      fieldName: 'cost_centre_id',
      oldValue,
      newValue: costCentreId,
      userId,
    });
  }
}
