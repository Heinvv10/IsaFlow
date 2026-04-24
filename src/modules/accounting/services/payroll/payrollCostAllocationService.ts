/**
 * Per-employee cost-allocation splits (mig 451).
 *
 * When an employee has rows in payroll_employee_cost_allocations, every
 * cost-centre report splits that employee's run amounts across the listed
 * centres by percentage. Without allocation rows the single-centre FK on
 * payroll_employees is used (existing Phase 4 behaviour).
 *
 * Sum-to-100% is enforced application-side inside a BEGIN/COMMIT so a
 * partial set can never persist. A 0.01 tolerance accommodates equal
 * thirds (33.33 / 33.33 / 33.34).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface CostAllocationInput {
  costCentreId: string;
  percentage: number;
}

export interface CostAllocation {
  id: string;
  costCentreId: string;
  costCentreCode: string;
  costCentreName: string;
  percentage: number;
}

export interface CostAllocationShare {
  costCentreId: string;
  percentage: number;
  amount: number;
}

export class AllocationSumError extends Error {
  constructor(actual: number) {
    super(`Allocation percentages must sum to 100 (got ${actual})`);
    this.name = 'AllocationSumError';
  }
}

export class DuplicateCostCentreError extends Error {
  constructor(costCentreId: string) {
    super(`Cost centre ${costCentreId} listed more than once in allocations`);
    this.name = 'DuplicateCostCentreError';
  }
}

const SUM_TOLERANCE = 0.01;

function validateLocal(allocations: CostAllocationInput[]): void {
  const seen = new Set<string>();
  for (const a of allocations) {
    if (!(a.percentage > 0) || a.percentage > 100) {
      throw new Error(`Invalid percentage ${a.percentage} for cost centre ${a.costCentreId}`);
    }
    if (seen.has(a.costCentreId)) throw new DuplicateCostCentreError(a.costCentreId);
    seen.add(a.costCentreId);
  }
  if (allocations.length > 0) {
    const sum = allocations.reduce((s, a) => s + a.percentage, 0);
    if (Math.abs(sum - 100) > SUM_TOLERANCE) throw new AllocationSumError(sum);
  }
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
  if (rows.length === 0) throw new Error(`Employee ${employeeId} not in company`);
}

async function assertCostCentresInCompany(
  companyId: string,
  costCentreIds: string[],
): Promise<void> {
  if (costCentreIds.length === 0) return;
  const rows = (await sql`
    SELECT id FROM cost_centres
     WHERE company_id = ${companyId}::uuid
       AND id = ANY(${costCentreIds}::uuid[])
  `) as Row[];
  if (rows.length !== costCentreIds.length) {
    throw new Error(`One or more cost centre ids not in company`);
  }
}

export async function setEmployeeCostAllocations(
  companyId: string,
  employeeId: string,
  allocations: CostAllocationInput[],
  userId: string,
): Promise<void> {
  validateLocal(allocations);
  await assertEmployeeInCompany(companyId, employeeId);
  await assertCostCentresInCompany(companyId, allocations.map(a => a.costCentreId));

  log.info(
    'Replacing employee cost allocations',
    { companyId, employeeId, count: allocations.length },
    'payrollCostAllocationService',
  );

  await sql`BEGIN`;
  try {
    await sql`
      DELETE FROM payroll_employee_cost_allocations
       WHERE company_id = ${companyId}::uuid
         AND employee_id = ${employeeId}::uuid
    `;
    for (const a of allocations) {
      await sql`
        INSERT INTO payroll_employee_cost_allocations
          (company_id, employee_id, cost_centre_id, percentage, created_by)
        VALUES (
          ${companyId}::uuid,
          ${employeeId}::uuid,
          ${a.costCentreId}::uuid,
          ${a.percentage},
          ${userId}
        )
      `;
    }
    await sql`COMMIT`;
  } catch (err) {
    await sql`ROLLBACK`;
    throw err;
  }
}

export async function getEmployeeCostAllocations(
  companyId: string,
  employeeId: string,
): Promise<CostAllocation[]> {
  const rows = (await sql`
    SELECT a.id,
           a.cost_centre_id,
           cc.code AS cost_centre_code,
           cc.name AS cost_centre_name,
           a.percentage
      FROM payroll_employee_cost_allocations a
      JOIN cost_centres cc ON cc.id = a.cost_centre_id
     WHERE a.company_id = ${companyId}::uuid
       AND a.employee_id = ${employeeId}::uuid
     ORDER BY a.percentage DESC, cc.code ASC
  `) as Row[];

  return rows.map(r => ({
    id: String(r.id),
    costCentreId: String(r.cost_centre_id),
    costCentreCode: String(r.cost_centre_code),
    costCentreName: String(r.cost_centre_name),
    percentage: Number(r.percentage),
  }));
}

export function splitRunLineAcrossAllocations(
  amount: number,
  allocations: CostAllocationInput[],
): CostAllocationShare[] {
  if (allocations.length === 0) return [];
  const round = (n: number) => Math.round(n * 100) / 100;
  const shares: CostAllocationShare[] = allocations.map(a => ({
    costCentreId: a.costCentreId,
    percentage: a.percentage,
    amount: round((amount * a.percentage) / 100),
  }));
  const summed = shares.reduce((s, p) => s + p.amount, 0);
  const residual = round(amount - summed);
  if (residual !== 0 && shares.length > 0) {
    const last = shares[shares.length - 1]!;
    last.amount = round(last.amount + residual);
  }
  return shares;
}
