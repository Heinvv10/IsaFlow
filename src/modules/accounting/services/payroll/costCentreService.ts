/**
 * Cost centre master + per-run cost-centre roll-up.
 *
 * The payroll_employees.cost_centre_id FK (mig 450) is the single source
 * of truth for cost allocation. Every active employee is either assigned
 * to exactly one cost centre or unassigned (NULL). costCentreSummaryForRun
 * groups a completed run's payroll_run_lines by that FK and returns a
 * per-centre breakdown plus grand totals.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface CostCentre {
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

function mapCostCentre(r: Row): CostCentre {
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

export interface CreateCostCentreInput {
  companyId: string;
  code: string;
  name: string;
  parentId?: string | null;
  notes?: string;
  userId: string;
}

export async function createCostCentre(input: CreateCostCentreInput): Promise<CostCentre> {
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
  `) as Row[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapCostCentre(rows[0]);
}

export interface ListCostCentresOptions {
  activeOnly?: boolean;
}

export async function listCostCentres(
  companyId: string,
  opts: ListCostCentresOptions = {},
): Promise<CostCentre[]> {
  const rows = (await sql`
    SELECT * FROM cost_centres
     WHERE company_id = ${companyId}::uuid
       AND (${opts.activeOnly === true ? true : false}::boolean = false OR is_active = true)
     ORDER BY code
  `) as Row[];
  return rows.map(mapCostCentre);
}

async function assertCostCentreInCompany(companyId: string, costCentreId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM cost_centres
     WHERE id = ${costCentreId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
  if (rows.length === 0) throw new CostCentreNotFoundError(costCentreId);
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
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
): Promise<void> {
  await assertEmployeeInCompany(companyId, employeeId);
  if (costCentreId !== null) {
    await assertCostCentreInCompany(companyId, costCentreId);
  }
  await sql`
    UPDATE payroll_employees
       SET cost_centre_id = ${costCentreId}::uuid,
           updated_at = NOW()
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `;
  log.info('Employee cost centre reassigned', { companyId, employeeId, costCentreId }, 'costCentreService');
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
  `) as Row[];
  if (runRows.length === 0) throw new Error(`Payroll run ${runId} not found in company`);

  const rows = (await sql`
    SELECT
      e.cost_centre_id                                                AS cost_centre_id,
      cc.code                                                         AS cost_centre_code,
      cc.name                                                         AS cost_centre_name,
      COUNT(DISTINCT prl.employee_id)::int                            AS employee_count,
      COALESCE(SUM(prl.gross_pay), 0)                                 AS total_gross,
      COALESCE(SUM(prl.paye), 0)                                      AS total_paye,
      COALESCE(SUM(prl.uif_employee + prl.uif_employer), 0)           AS total_uif,
      COALESCE(SUM(prl.sdl), 0)                                       AS total_sdl,
      COALESCE(SUM(prl.eti), 0)                                       AS total_eti,
      COALESCE(SUM(prl.net_pay), 0)                                   AS total_net
    FROM payroll_run_lines prl
    JOIN payroll_employees e ON e.id = prl.employee_id
    LEFT JOIN cost_centres cc ON cc.id = e.cost_centre_id
    WHERE prl.run_id = ${runId}::uuid
    GROUP BY e.cost_centre_id, cc.code, cc.name
    ORDER BY COALESCE(cc.code, 'zzz')
  `) as Row[];

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
