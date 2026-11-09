/**
 * Reading and writing an employee's fringe-benefit inputs (company vehicle, travel allowance): the rows
 * payroll_employee_fringe_benefits (migration 970). The rules that turn them into tax are in fringeBenefits.ts.
 *
 * A row is never deleted: a finalised payslip was costed from it. It is ended (effective_to). Every write takes the
 * company payroll lock, refuses a change that would alter a month a paid run already read, and leaves an audit row
 * (entity payroll_fringe_benefit) that the approval gate reads, so a run calculated before the change is told to
 * recalculate (payrollRunRecalcGate). Refusals are thrown before the first write (a 4xx commits).
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { benefitActiveInPeriod, isRealIsoDay, type FringeBenefit, type FringeKind } from './fringeBenefits';
import { lockCompanyPayrollForComponentChange, paidPeriodsOf, periodLabel } from './payrollComponentPaidMonths';
import type { ComponentChangeActor } from './payrollComponentAudit';
import type { PayrollComponent, PayrollPeriod } from './payrollTypes';

export class FringeBenefitRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FringeBenefitRefused';
  }
}

export interface FringeBenefitInput {
  kind: FringeKind;
  determinedValue: number | null;
  maintenancePlan: boolean;
  businessUseAtLeast80: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}


function mapRow(r: DbRow): FringeBenefit {
  return {
    id: String(r.id),
    kind: r.kind as FringeKind,
    determinedValue: r.determined_value === null || r.determined_value === undefined ? null : Number(r.determined_value),
    maintenancePlan: r.maintenance_plan === true,
    businessUseAtLeast80: r.business_use_at_least_80 === true,
    effectiveFrom: fmtDate(r.effective_from),
    effectiveTo: r.effective_to ? fmtDate(r.effective_to) : null,
  };
}



/** The employee's rows, newest first; null when the employee is not in the company. */
export async function listFringeBenefits(companyId: string, employeeId: string): Promise<FringeBenefit[] | null> {
  const emp = (await sql`SELECT 1 FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid`) as DbRow[];
  if (emp.length === 0) return null;
  const rows = (await sql`
    SELECT id, employee_id, kind, determined_value, maintenance_plan, business_use_at_least_80, effective_from, effective_to
      FROM payroll_employee_fringe_benefits
     WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
     ORDER BY effective_from DESC, created_at DESC
  `) as DbRow[];
  return rows.map(mapRow);
}

/** Every employee's rows for a run, by employee id. Employees with none are absent. */
export async function loadFringeBenefitsByEmployee(companyId: string, employeeIds: readonly string[]): Promise<Map<string, FringeBenefit[]>> {
  const out = new Map<string, FringeBenefit[]>();
  if (employeeIds.length === 0) return out;
  const rows = (await sql`
    SELECT id, employee_id, kind, determined_value, maintenance_plan, business_use_at_least_80, effective_from, effective_to
      FROM payroll_employee_fringe_benefits
     WHERE company_id = ${companyId}::uuid AND employee_id = ANY(${[...employeeIds]}::uuid[])
     ORDER BY effective_from, created_at
  `) as DbRow[];
  for (const r of rows) {
    const key = String(r.employee_id);
    out.set(key, [...(out.get(key) ?? []), mapRow(r)]);
  }
  return out;
}

/** The earning a vehicle benefit is shown with: the first active taxable earning coded 3802 (as the loan benefit's 3801). */
export async function loadVehicleBenefitComponent(companyId: string, db: TxSql | typeof sql = sql): Promise<PayrollComponent | null> {
  const rows = (await db`
    SELECT id, name, sars_source_code, component_type, is_taxable, is_uif_applicable, is_sdl_applicable
      FROM payroll_components
     WHERE company_id = ${companyId}::uuid AND is_active = true AND component_type = 'earning' AND is_taxable = true
       AND BTRIM(sars_source_code, E' \t\r\n') = '3802'
     ORDER BY created_at, id
     LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), name: String(r.name), sarsSourceCode: String(r.sars_source_code), componentType: 'earning',
    isTaxable: true, isUifApplicable: r.is_uif_applicable === true, isSdlApplicable: r.is_sdl_applicable === true,
  };
}

function checkInput(i: FringeBenefitInput): void {
  if (!isRealIsoDay(i.effectiveFrom) || (i.effectiveTo !== null && !isRealIsoDay(i.effectiveTo))) throw new FringeBenefitRefused('Dates must be YYYY-MM-DD');
  if (i.effectiveTo !== null && i.effectiveTo < i.effectiveFrom) throw new FringeBenefitRefused('The end date is before the start date');
  if (i.kind === 'company_vehicle' && !(i.determinedValue !== null && i.determinedValue > 0)) {
    throw new FringeBenefitRefused('A company vehicle needs its determined value (Seventh Schedule para 7)');
  }
  if (i.kind === 'travel_allowance' && (i.determinedValue !== null || i.maintenancePlan)) {
    throw new FringeBenefitRefused('A travel allowance has no determined value or maintenance plan');
  }
}

const overlaps = (a: { from: string; to: string | null }, b: { from: string; to: string | null }): boolean =>
  a.from <= (b.to ?? '9999-12-31') && b.from <= (a.to ?? '9999-12-31');

/** A paid month inside [from, to]: the paid run read this employee's benefit state there, so it cannot change. */
async function refusePaidMonth(tx: Parameters<typeof paidPeriodsOf>[0], companyId: string, employeeId: string, from: string, to: string | null): Promise<void> {
  const hit = (await paidPeriodsOf(tx, companyId, employeeId)).find((p: PayrollPeriod) => benefitActiveInPeriod({ effectiveFrom: from, effectiveTo: to }, p));
  if (hit) {
    throw new FringeBenefitRefused(`${periodLabel(hit)} is already paid. A fringe benefit cannot change a paid month: reopen that run and reverse its journal first.`);
  }
}

async function lockEmployee(tx: Parameters<typeof paidPeriodsOf>[0], companyId: string, employeeId: string): Promise<void> {
  await lockCompanyPayrollForComponentChange(tx, companyId);
  const rows = (await tx`SELECT 1 FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid`) as DbRow[];
  if (rows.length === 0) throw new FringeBenefitRefused('Employee not found');
}

export async function createFringeBenefit(
  companyId: string, employeeId: string, input: FringeBenefitInput, actor: ComponentChangeActor,
): Promise<FringeBenefit> {
  checkInput(input);
  return withTransaction(async (tx) => {
    await lockEmployee(tx, companyId, employeeId);
    if (input.kind === 'company_vehicle' && !(await loadVehicleBenefitComponent(companyId, tx))) {
      throw new FringeBenefitRefused('Add a taxable earning coded 3802 to the pay components first: the vehicle benefit is shown on the payslip with it');
    }
    const existing = (await tx`
      SELECT id, kind, determined_value, maintenance_plan, business_use_at_least_80, effective_from, effective_to
        FROM payroll_employee_fringe_benefits
       WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid AND kind = ${input.kind}
    `) as DbRow[];
    const win = { from: input.effectiveFrom, to: input.effectiveTo };
    if (existing.map(mapRow).some((b) => overlaps(win, { from: b.effectiveFrom, to: b.effectiveTo }))) {
      throw new FringeBenefitRefused('This employee already has that benefit for part of those dates: end the existing one first');
    }
    await refusePaidMonth(tx, companyId, employeeId, input.effectiveFrom, input.effectiveTo);
    const rows = (await tx`
      INSERT INTO payroll_employee_fringe_benefits (
        company_id, employee_id, kind, determined_value, maintenance_plan, business_use_at_least_80,
        effective_from, effective_to, created_by
      ) VALUES (
        ${companyId}::uuid, ${employeeId}::uuid, ${input.kind}, ${input.determinedValue}, ${input.maintenancePlan},
        ${input.businessUseAtLeast80}, ${input.effectiveFrom}::date, ${input.effectiveTo}::date, ${actor.userId}
      )
      RETURNING id, employee_id, kind, determined_value, maintenance_plan, business_use_at_least_80, effective_from, effective_to
    `) as DbRow[];
    const row = rows[0];
    if (!row) throw new Error('INSERT returned no row');
    await auditFringe(tx, companyId, String(row.id), null, input, actor);
    log.info('Fringe benefit created', { companyId, employeeId, kind: input.kind }, 'fringeBenefitService');
    return mapRow(row);
  });
}

/** End a benefit on `effectiveTo` (never earlier than its start). Returns false when it matches nothing in the company. */
export async function endFringeBenefit(
  companyId: string, employeeId: string, benefitId: string, effectiveTo: string, actor: ComponentChangeActor,
): Promise<boolean> {
  if (!isRealIsoDay(effectiveTo)) throw new FringeBenefitRefused('Dates must be YYYY-MM-DD');
  return withTransaction(async (tx) => {
    await lockEmployee(tx, companyId, employeeId);
    const rows = (await tx`
      SELECT id, kind, determined_value, maintenance_plan, business_use_at_least_80, effective_from, effective_to
        FROM payroll_employee_fringe_benefits
       WHERE id = ${benefitId}::uuid AND company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
       FOR UPDATE
    `) as DbRow[];
    if (!rows[0]) return false;
    const before = mapRow(rows[0]);
    if (effectiveTo < before.effectiveFrom) throw new FringeBenefitRefused('The end date is before the start date');
    if (before.effectiveTo !== null && effectiveTo >= before.effectiveTo) {
      throw new FringeBenefitRefused('End only shortens a benefit: that date is not before its current end');
    }
    // The months this change removes: after the new end, up to the old end.
    const next = new Date(`${effectiveTo}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await refusePaidMonth(tx, companyId, employeeId, next.toISOString().slice(0, 10), before.effectiveTo);
    await tx`
      UPDATE payroll_employee_fringe_benefits SET effective_to = ${effectiveTo}::date
       WHERE id = ${benefitId}::uuid AND company_id = ${companyId}::uuid
    `;
    await auditFringe(tx, companyId, benefitId, before, { ...before, effectiveTo }, actor);
    return true;
  });
}

async function auditFringe(
  tx: Parameters<typeof paidPeriodsOf>[0], companyId: string, benefitId: string,
  before: { effectiveTo: string | null } | null, after: FringeBenefitInput | FringeBenefit, actor: ComponentChangeActor,
): Promise<void> {
  // Dates, kind and flags only: never the determined value (an employee's pay).
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: before ? 'update' : 'create',
    entityType: 'payroll_fringe_benefit', entityId: benefitId, atClockTime: true,
    changes: {
      fields: [
        { field: 'effective_to', old: before?.effectiveTo ?? null, new: after.effectiveTo, label: 'Effective to' },
        { field: 'business_use_at_least_80', old: null, new: String(after.businessUseAtLeast80), label: 'Business use at least 80%' },
      ],
      metadata: { kind: after.kind, channel: actor.channel },
    },
  }, tx);
}
