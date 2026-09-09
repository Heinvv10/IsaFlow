/**
 * Cost Centre Service — GL analysis codes (cc1/cc2) + payroll HR assignment.
 *
 * Accounting GL cost centres use cc_type to distinguish cc1 vs cc2 dimensions.
 * Payroll cost centres track per-employee assignment and run-level roll-ups.
 * The payroll_employees.cost_centre_id FK (mig 450, made RESTRICT by mig 649)
 * is the single source of truth for HR cost allocation. costCentreSummaryForRun
 * groups a run's payroll_run_lines by it. Delete eligibility: costCentreUsageGuard.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { recordEmployeeChange } from '../payroll/payrollEmployeeHistoryService';
import { assertCostCentreUnused, cannotDeleteMessage, FK_VIOLATION } from './costCentreUsageGuard';

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

export interface CostCentreInput {
  code: string;
  name: string;
  description?: string;
  department?: string;
  ccType?: CcType;
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

export async function createGlCostCentre(companyId: string, input: CostCentreInput, _userId: string): Promise<CostCentre> {
  const rows = (await sql`
    INSERT INTO cost_centres (company_id, code, name, description, department, cc_type)
    VALUES (${companyId}, ${input.code}, ${input.name}, ${input.description || null}, ${input.department || null}, ${input.ccType || 'cc1'})
    RETURNING *
  `) as Record<string, unknown>[];
  log.info('Created cost centre', { id: rows[0]!.id, code: input.code }, 'accounting');
  return mapGlRow(rows[0]!);
}

export async function updateGlCostCentre(companyId: string, id: string, input: Partial<CostCentreInput>): Promise<CostCentre> {
  const rows = (await sql`
    UPDATE cost_centres SET
      code = COALESCE(${input.code || null}, code),
      name = COALESCE(${input.name || null}, name),
      description = COALESCE(${input.description || null}, description),
      department = COALESCE(${input.department || null}, department)
    WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error(`Cost centre ${id} not found`);
  return mapGlRow(rows[0]);
}

export async function toggleCostCentre(companyId: string, id: string, isActive: boolean): Promise<void> {
  const result = (await sql`UPDATE cost_centres SET is_active = ${isActive} WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING id`) as Record<string, unknown>[];
  if (result.length === 0) throw new Error(`Cost centre not found: ${id}`);
}

export async function deleteCostCentre(companyId: string, id: string): Promise<void> {
  await assertCostCentreUnused(companyId, id);
  try {
    await sql`DELETE FROM cost_centres WHERE id = ${id}::UUID AND company_id = ${companyId}`;
  } catch (err) {
    // Guard is tenant-scoped, the RESTRICT FKs are not: another company's row
    // is invisible above and reaches us as a 23503.
    if ((err as { code?: string }).code === FK_VIOLATION) throw new Error(cannotDeleteMessage([]));
    throw err;
  }
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

export interface CreatePayrollCostCentreInput {
  companyId: string;
  code: string;
  name: string;
  parentId?: string | null;
  notes?: string;
  userId: string;
}

export async function createCostCentre(input: CreatePayrollCostCentreInput): Promise<PayrollCostCentre> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new Error('code is required');
  if (!name) throw new Error('name is required');

  log.info('Creating cost centre', { companyId: input.companyId, code }, 'costCentreService');

  const rows = (await sql`
    INSERT INTO cost_centres (company_id, code, name, parent_id, notes, created_by)
    VALUES (
      ${input.companyId}::uuid,
      ${code},
      ${name},
      ${input.parentId ?? null},
      ${input.notes ?? null},
      ${input.userId}
    )
    RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapPayrollRow(rows[0]);
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

export interface UpdateCostCentreInput {
  code?: string;
  name?: string;
  parentId?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export async function updateCostCentre(
  companyId: string,
  costCentreId: string,
  input: UpdateCostCentreInput,
): Promise<void> {
  await assertCostCentreInCompany(companyId, costCentreId);

  const code = input.code !== undefined ? input.code.trim() : null;
  const name = input.name !== undefined ? input.name.trim() : null;

  await sql`
    UPDATE cost_centres
       SET code       = COALESCE(${code}, code),
           name       = COALESCE(${name}, name),
           parent_id  = COALESCE(${input.parentId ?? null}::uuid, parent_id),
           notes      = COALESCE(${input.notes ?? null}, notes),
           is_active  = COALESCE(${input.isActive ?? null}::boolean, is_active),
           updated_at = NOW()
     WHERE id = ${costCentreId}::uuid AND company_id = ${companyId}::uuid
  `;
}

export async function deactivateCostCentre(companyId: string, costCentreId: string): Promise<void> {
  await assertCostCentreInCompany(companyId, costCentreId);
  await sql`
    UPDATE cost_centres
       SET is_active = ${false}, updated_at = NOW()
     WHERE id = ${costCentreId}::uuid AND company_id = ${companyId}::uuid
  `;
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

export interface CostCentreSummaryRow {
  costCentreId: string | null;
  costCentreCode: string | null;
  costCentreName: string | null;
  employeeCount: number;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
}

export interface CostCentreSummary {
  runId: string;
  rows: CostCentreSummaryRow[];
  totals: {
    employeeCount: number;
    totalGross: number;
    totalPaye: number;
    totalUif: number;
    totalSdl: number;
    totalEti: number;
    totalNet: number;
  };
}

export async function costCentreSummaryForRun(
  companyId: string,
  runId: string,
): Promise<CostCentreSummary> {
  const runRows = (await sql`
    SELECT id FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Record<string, unknown>[];
  if (runRows.length === 0) throw new Error(`Payroll run ${runId} not found in company`);

  // Per-employee cost allocations (mig 451) override the single-centre FK
  // when present. The CTE below produces one row per (run-line × centre),
  // weighted by allocation percentage, with a fallback row for employees
  // that have no allocations.
  const rows = (await sql`
    WITH line_splits AS (
      SELECT prl.employee_id,
             prl.gross_pay,
             prl.paye,
             prl.uif_employee,
             prl.uif_employer,
             prl.sdl,
             prl.eti,
             prl.net_pay,
             a.cost_centre_id        AS allocated_cost_centre_id,
             (a.percentage / 100.0)  AS weight
        FROM payroll_run_lines prl
        JOIN payroll_employee_cost_allocations a
          ON a.company_id = ${companyId}::uuid
         AND a.employee_id = prl.employee_id
       WHERE prl.run_id = ${runId}::uuid
      UNION ALL
      SELECT prl.employee_id,
             prl.gross_pay,
             prl.paye,
             prl.uif_employee,
             prl.uif_employer,
             prl.sdl,
             prl.eti,
             prl.net_pay,
             e.cost_centre_id        AS allocated_cost_centre_id,
             1.0                     AS weight
        FROM payroll_run_lines prl
        JOIN payroll_employees e ON e.id = prl.employee_id
       WHERE prl.run_id = ${runId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM payroll_employee_cost_allocations a2
            WHERE a2.company_id = ${companyId}::uuid
              AND a2.employee_id = prl.employee_id
         )
    )
    SELECT
      ls.allocated_cost_centre_id                                     AS cost_centre_id,
      cc.code                                                         AS cost_centre_code,
      cc.name                                                         AS cost_centre_name,
      COUNT(DISTINCT ls.employee_id)::int                             AS employee_count,
      COALESCE(SUM(ls.gross_pay * ls.weight), 0)                      AS total_gross,
      COALESCE(SUM(ls.paye * ls.weight), 0)                           AS total_paye,
      COALESCE(SUM((ls.uif_employee + ls.uif_employer) * ls.weight), 0) AS total_uif,
      COALESCE(SUM(ls.sdl * ls.weight), 0)                            AS total_sdl,
      COALESCE(SUM(ls.eti * ls.weight), 0)                            AS total_eti,
      COALESCE(SUM(ls.net_pay * ls.weight), 0)                        AS total_net
    FROM line_splits ls
    LEFT JOIN cost_centres cc ON cc.id = ls.allocated_cost_centre_id
    GROUP BY ls.allocated_cost_centre_id, cc.code, cc.name
    ORDER BY COALESCE(cc.code, 'zzz')
  `) as Record<string, unknown>[];

  const rowsOut: CostCentreSummaryRow[] = rows.map(r => ({
    costCentreId: r.cost_centre_id == null ? null : String(r.cost_centre_id),
    costCentreCode: r.cost_centre_code == null ? null : String(r.cost_centre_code),
    costCentreName: r.cost_centre_name == null ? null : String(r.cost_centre_name),
    employeeCount: Number(r.employee_count ?? 0),
    totalGross: Number(r.total_gross ?? 0),
    totalPaye: Number(r.total_paye ?? 0),
    totalUif: Number(r.total_uif ?? 0),
    totalSdl: Number(r.total_sdl ?? 0),
    totalEti: Number(r.total_eti ?? 0),
    totalNet: Number(r.total_net ?? 0),
  }));

  const totals = rowsOut.reduce(
    (acc, r) => ({
      employeeCount: acc.employeeCount + r.employeeCount,
      totalGross: acc.totalGross + r.totalGross,
      totalPaye: acc.totalPaye + r.totalPaye,
      totalUif: acc.totalUif + r.totalUif,
      totalSdl: acc.totalSdl + r.totalSdl,
      totalEti: acc.totalEti + r.totalEti,
      totalNet: acc.totalNet + r.totalNet,
    }),
    { employeeCount: 0, totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, totalEti: 0, totalNet: 0 },
  );

  return { runId, rows: rowsOut, totals };
}
