/**
 * Planned hires and the headcount read (P4 decision 7). A hire is a role label, an optional cost
 * centre of the company, a month range and an FTE, stored per version; a change recomputes the
 * version with every per_head row live (they move) through `runDriverWrite`. The headcount read answers COUNTS
 * only: per month payroll actives, hires and their total at a scope, and when payroll was read.
 */
import { sql, type DbRow } from '@/lib/neon';
import { budgetMonthKeysInWindow } from '../../reports/budgetPeriodWindow';
import { BudgetDriverError } from './driverErrors';
import { versionYear } from '../budgetVersionScope';
import { inputError } from '../gridErrors';
import {
  deletePlannedHire, insertPlannedHire, listPlannedHires, updatePlannedHire,
  type PlannedHireInput, type StoredPlannedHire,
} from './driverRepository';
import { versionHeadcount } from './driverHeadcount';
import { runDriverWrite, type DriverWriteTarget } from './driverWriteScope';
import type { PerHeadAccess, RestrictedHeadcount } from './perHeadAccess';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** NUMERIC(6,2) */
const MAX_FTE = 9999.99;

async function assertCostCentre(companyId: string, costCentreId: string | null): Promise<void> {
  if (costCentreId === null) return;
  const rows = (await sql`
    SELECT 1 FROM cost_centres WHERE id = ${costCentreId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!rows[0]) throw inputError(`Cost centre ${costCentreId} is not a cost centre of this company`);
}

/** Trimmed, checked, ids lower-cased; it must count in at least one of the version's months. */
function checkedHire(h: PlannedHireInput, months: readonly string[]): PlannedHireInput {
  const label = h.label.trim();
  if (label.length < 1 || label.length > 120) throw inputError('A planned hire needs a role label of 1 to 120 characters');
  if (!MONTH.test(h.startMonth) || (h.endMonth !== null && !MONTH.test(h.endMonth))) throw inputError('Hire months are YYYY-MM');
  if (h.endMonth !== null && h.endMonth < h.startMonth) throw inputError('A hire cannot end before it starts');
  if (!Number.isFinite(h.fte) || h.fte <= 0 || h.fte > MAX_FTE || Math.round(h.fte * 100) / 100 !== h.fte) {
    throw inputError('FTE must be more than 0, at most 9999.99, with at most 2 decimals');
  }
  const first = months[0]!;
  const last = months[months.length - 1]!;
  if (h.startMonth > last || (h.endMonth !== null && h.endMonth < first)) {
    throw inputError(`The hire's months do not overlap this budget's year (${first} to ${last})`);
  }
  return { label, costCentreId: h.costCentreId?.toLowerCase() ?? null, startMonth: h.startMonth, endMonth: h.endMonth, fte: h.fte };
}

export async function listHires(companyId: string, versionId: string): Promise<{ hires: StoredPlannedHire[] }> {
  await versionYear(companyId, versionId);
  return { hires: await listPlannedHires(companyId, versionId.toLowerCase()) };
}

export async function createHire(companyId: string, userId: string, target: DriverWriteTarget, input: PlannedHireInput) {
  return runDriverWrite(companyId, userId, target, 'hire_created', async (ctx) => {
    const h = checkedHire(input, ctx.months);
    await assertCostCentre(companyId, h.costCentreId);
    const hire = await insertPlannedHire(companyId, ctx.versionId, userId, h);
    return { value: { hire }, audit: { hireId: hire.id }, live: 'all' as const };
  });
}

export async function updateHire(companyId: string, userId: string, target: DriverWriteTarget, hireId: string, input: PlannedHireInput) {
  return runDriverWrite(companyId, userId, target, 'hire_updated', async (ctx) => {
    const h = checkedHire(input, ctx.months);
    await assertCostCentre(companyId, h.costCentreId);
    const hire = await updatePlannedHire(companyId, ctx.versionId, hireId.toLowerCase(), h);
    if (!hire) throw new BudgetDriverError('PLANNED_HIRE_NOT_FOUND', 'Planned hire not found in this version');
    return { value: { hire }, audit: { hireId: hire.id }, live: 'all' as const };
  });
}

export async function deleteHire(companyId: string, userId: string, target: DriverWriteTarget, hireId: string) {
  return runDriverWrite(companyId, userId, target, 'hire_deleted', async (ctx) => {
    if (!(await deletePlannedHire(companyId, ctx.versionId, hireId.toLowerCase()))) {
      throw new BudgetDriverError('PLANNED_HIRE_NOT_FOUND', 'Planned hire not found in this version');
    }
    return { value: { deleted: true as const, id: hireId.toLowerCase() }, audit: { hireId: hireId.toLowerCase() }, live: 'all' as const };
  });
}

export interface HeadcountMonth {
  /** 'YYYY-MM' */
  month: string;
  payroll: number;
  hires: number;
  total: number;
}

export interface VersionHeadcount {
  /** Cost centre id; null = the company. */
  costCentreId: string | null;
  months: HeadcountMonth[];
  /** When payroll was read (UTC ISO). */
  asOf: string;
}

/**
 * Headcount per month of the version's year at a scope: counts only, never names or pay. `totals`
 * access (a budget reader) gets no counts and payroll is not read: counts beside a per_head row's
 * totals give the per-head rate back (decision 15). The version and centre are checked either way.
 */
export async function readHeadcount(companyId: string, versionId: string, costCentreId: string | null, access: 'full'): Promise<VersionHeadcount>;
export async function readHeadcount(
  companyId: string, versionId: string, costCentreId: string | null, access: PerHeadAccess,
): Promise<VersionHeadcount | RestrictedHeadcount>;
export async function readHeadcount(
  companyId: string, versionId: string, costCentreId: string | null, access: PerHeadAccess,
): Promise<VersionHeadcount | RestrictedHeadcount> {
  const year = await versionYear(companyId, versionId);
  const scope = costCentreId?.toLowerCase() ?? null;
  await assertCostCentre(companyId, scope);
  if (access !== 'full') return { costCentreId: scope, perHeadRestricted: true };
  const months = budgetMonthKeysInWindow(year.startDate, year.endDate);
  const asOf = new Date().toISOString();
  const counts = (await versionHeadcount(companyId, versionId.toLowerCase(), months))(scope);
  return {
    costCentreId: scope,
    months: months.map((month) => {
      const c = counts.get(month) ?? { payroll: 0, hires: 0, total: 0 };
      return { month, payroll: c.payroll, hires: c.hires, total: c.total };
    }),
    asOf,
  };
}
