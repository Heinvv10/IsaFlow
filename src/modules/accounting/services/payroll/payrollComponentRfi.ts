/**
 * The write rules for retirement-funding income and employer fund contributions (wave 5 RF, migration 975).
 *
 * Components:
 *   - `counts_as_rfi` (earnings only, CHECK): the earning is part of RFI, the base a percent_of_rfi row is costed on (rfi.ts).
 *     A new earning coded 3601 counts by default, as migration 975 backfilled every existing one. An employer's fund
 *     contribution itself (3817 / 3825 / 3828) never counts: it is not the employee's pay.
 *   - An employer's fund contribution earning (3817 pension, 3825 provident, 3828 retirement annuity; BRS V25.3.0 p. 94-95)
 *     must be taxable (a taxable fringe benefit, PAYE-GEN-01-G21 (2027) p. 10) and created for a DEFINED-CONTRIBUTION fund
 *     (`fundType`). A defined-benefit fund's benefit is not the contribution paid but a value worked out under the Seventh
 *     Schedule para 12D(3) fund member category factors, which IsaFlow does not model: refused, and logged.
 * Assignments: `percent_of_rfi` is a fraction (0 < p <= 1, four decimals; NUMERIC(6,4)) with amount 0, on a retirement
 * contribution only (rfi.percentOfRfiRefusal).
 * Changing `counts_as_rfi` after a run was calculated changes what its percent rows should cost: the change is audited
 * (entity payroll_component), and the approval gate refuses such a run until it is recalculated (payrollRunRecalcGate).
 */
import { withTransaction, type TxSql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { normaliseSarsCode } from './payeAnnualPayment';
import { lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { isEmployerFundBenefitCode } from './retirementFund';
import { percentOfRfiRefusal } from './rfi';
import type { ComponentChangeActor } from './payrollComponentAudit';

export const DEFINED_BENEFIT_REFUSAL = 'An employer contribution to a DEFINED-BENEFIT fund cannot be processed: its taxable benefit is not the contribution paid '
  + 'but a value worked out from the fund member category factors (Seventh Schedule para 12D(3)), which IsaFlow does not calculate. '
  + 'Only defined-contribution (money purchase) funds are supported. Ask the fund for the benefit value and file it by hand.';

/** The counts_as_rfi a new component gets when the request does not say: an earning coded 3601 counts (migration 975's rule). */
export function defaultCountsAsRfi(componentType: string, code: string): boolean {
  return componentType === 'earning' && normaliseSarsCode(code) === '3601';
}

/** Why this component cannot count as RFI, or null: an earning, and not an employer's own fund contribution. */
function rfiFlagRefusal(componentType: string, code: string): string | null {
  if (componentType !== 'earning') return 'Only an earning can count as retirement-funding income.';
  if (isEmployerFundBenefitCode(normaliseSarsCode(code))) {
    return 'An employer\'s retirement fund contribution is not the employee\'s pay, so it cannot count as retirement-funding income.';
  }
  return null;
}

/**
 * Why a new component's RF fields are refused, or null. `countsAsRfi` is a boolean or absent; `fundType` is required on an
 * employer fund contribution earning and must be 'defined_contribution'.
 */
export function componentRfiRefusal(c: { componentType: string; code: string; isTaxable: boolean; isUifApplicable?: boolean; isSdlApplicable?: boolean; countsAsRfi: unknown; fundType: unknown }): string | null {
  if (c.countsAsRfi !== undefined && typeof c.countsAsRfi !== 'boolean') return 'countsAsRfi must be true or false';
  const fund = c.componentType === 'earning' && isEmployerFundBenefitCode(normaliseSarsCode(c.code));
  const flag = c.countsAsRfi === true ? rfiFlagRefusal(c.componentType, c.code) : null;
  if (flag) return flag;
  if (!fund) return c.fundType === undefined ? null : 'fundType applies only to an employer retirement fund contribution (codes 3817, 3825, 3828).';
  if (c.fundType === 'defined_benefit') return DEFINED_BENEFIT_REFUSAL;
  if (c.fundType !== 'defined_contribution') {
    return 'An employer retirement fund contribution (3817, 3825, 3828) needs fundType: \'defined_contribution\' (a money purchase fund). '
      + 'Defined-benefit funds are not supported.';
  }
  if (!c.isTaxable) return 'An employer retirement fund contribution is a taxable fringe benefit (PAYE-GEN-01-G21 (2027) p. 10): it must be taxable.';
  if (c.isUifApplicable === false || c.isSdlApplicable === false) {
    return 'An employer retirement fund contribution is Fourth Schedule remuneration, on which UIF and SDL are levied (UI Contributions Act s1; '
      + 'UIF-GEN-01-G01 p. 5; PAYE-GEN-01-G21 (2027) p. 11): it must be UIF and SDL applicable.';
  }
  return null;
}

/** Log a refused defined-benefit request (the spec's "refused with a message (logged)"); names no amount. */
export function logDefinedBenefitRefusal(companyId: string, code: string): void {
  log.info('Defined-benefit employer fund contribution refused', { companyId, code: normaliseSarsCode(code) }, 'payrollComponentRfi');
}

const FOUR_DECIMALS = (n: number): boolean => Math.abs(Math.round(n * 10_000) - n * 10_000) < 1e-6;

/** The assignment's percent_of_rfi judged before its insert (EmployeeComponentRefused: the route answers 400, nothing written). */
export async function judgePercentOfRfi(tx: TxSql, companyId: string, componentId: string, percentOfRfi: unknown, amount: number, isRecurring = true): Promise<void> {
  if (typeof percentOfRfi !== 'number' || !Number.isFinite(percentOfRfi) || percentOfRfi <= 0 || percentOfRfi > 1 || !FOUR_DECIMALS(percentOfRfi)) {
    throw new EmployeeComponentRefused('percentOfRfi must be a fraction above 0 and at most 1, to four decimals (0.075 = 7.5%).');
  }
  // A fund contributes every month on RFI: a once-off percentage would be a one-month row the run grid then edits as an amount.
  if (!isRecurring) throw new EmployeeComponentRefused('A percentage of retirement-funding income must be recurring: a once-off contribution is a fixed amount.');
  if (amount !== 0) throw new EmployeeComponentRefused('A percentage of retirement-funding income is costed by each run: send amount 0 with percentOfRfi.');
  const row = ((await tx`
    SELECT component_type, sars_source_code FROM payroll_components WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  const refused = row ? percentOfRfiRefusal(String(row.component_type), String(row.sars_source_code)) : 'That pay component was not found in this company';
  if (refused) throw new EmployeeComponentRefused(refused);
}

/**
 * At assign time (RF round 1): a new assignment of an employer fund contribution earning gets the RF treatment, so a component
 * made before RF that is not taxable (it would be refused at approval, RETIREMENT_BENEFIT_NOT_TAXABLE) is refused here, before
 * the insert. NAMED LIMIT: such a component never answered the defined-contribution question (create-time only); nothing stored
 * says which fund kind it is, so an older defined-benefit component is not caught here.
 */
export async function judgeFundAssignment(tx: TxSql, companyId: string, componentId: string): Promise<void> {
  const row = ((await tx`
    SELECT component_type, sars_source_code, is_taxable FROM payroll_components WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!row || row.component_type !== 'earning' || !isEmployerFundBenefitCode(normaliseSarsCode(String(row.sars_source_code)))) return;
  if (row.is_taxable !== true) {
    throw new EmployeeComponentRefused('This employer retirement fund contribution component is not taxable, but the contribution is a taxable fringe benefit '
      + '(PAYE-GEN-01-G21 (2027) p. 10). Create a taxable component for it (pay components page) and assign that.');
  }
}

/**
 * Switch a component's counts_as_rfi. Under the company payroll lock (as every component writer), audited in the same
 * transaction. Returns false when no earning of that id is in the company (a 404); refuses an employer fund contribution.
 */
export async function setComponentCountsAsRfi(companyId: string, componentId: string, countsAsRfi: boolean, actor: ComponentChangeActor): Promise<boolean> {
  return withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    const row = ((await tx`
      SELECT component_type, sars_source_code, counts_as_rfi FROM payroll_components
       WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
    `) as DbRow[])[0];
    if (!row) return false;
    const refused = countsAsRfi ? rfiFlagRefusal(String(row.component_type), String(row.sars_source_code)) : null;
    if (refused) throw new EmployeeComponentRefused(refused);
    if (row.counts_as_rfi === countsAsRfi) return true;
    await tx`UPDATE payroll_components SET counts_as_rfi = ${countsAsRfi} WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid`;
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update',
      entityType: 'payroll_component', entityId: componentId, atClockTime: true,
      changes: { fields: [{ field: 'counts_as_rfi', old: String(row.counts_as_rfi === true), new: String(countsAsRfi), label: 'Counts as retirement-funding income' }], metadata: { channel: actor.channel } },
    }, tx);
    log.info('Component counts_as_rfi changed', { companyId, componentId, countsAsRfi }, 'payrollComponentRfi');
    return true;
  });
}
