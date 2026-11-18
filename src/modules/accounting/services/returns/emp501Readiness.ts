/**
 * What stops an EMP501 being finalised (wave 6 EFb): IRP5 pre-validation errors for the return's period (PV,
 * preValidateTaxYear: an error is a certificate e@syFile would reject), and, per month the EMP501 reconciles
 * (emp501Months: a final pay run or a standalone directive payment), an EMP201 that is not filed, a filed EMP201 whose
 * PAYE, UIF or SDL differ from the month's certificates, or a filed EMP201 that has drifted (driftOf). A run that is not
 * final is not in the EMP501: a warning, never a refusal. Read-only; the GET shows it and the finalise refuses on it
 * before its first write.
 */
import { preValidateTaxYear } from '@/modules/accounting/services/payroll/preValidationService';
import type { Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { isRunKindUnsupported } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import {
  emp201Differences, emp501Months, filedEmp201PeriodTotals, filedTotals, monthName, notFinalRunMonths, type MonthTotals,
} from './emp501Months';
import { driftOf } from './returnDrift';
import { ReturnRefusal } from './returnVersionTypes';

export const EMP501_NOT_READY = 'EMP501_NOT_READY';

export interface Emp501Readiness {
  /** Pre-validation errors (warnings never block). */
  validationErrors: number;
  /** Names of the employees with an error, at most 10. */
  employeesWithErrors: string[];
  codeReleaseLoaded: boolean;
  /** YYYY-MM of every month with a final pay run or a standalone directive payment and no filed EMP201, in order. */
  unfiledEmp201Months: string[];
  /** A filed EMP201 whose totals are not the month's certificates: 'March 2025: PAYE 4000.00 filed, 9000.00 on the certificates'. */
  emp201Mismatches: string[];
  /** YYYY-MM of every month whose filed EMP201 has drifted from the payroll. */
  driftedEmp201Months: string[];
  /** Never blocks: 'June 2025 has a run that is not final' (it is not in the EMP501); an EMP201 filed without figures. */
  warnings: string[];
  /** Every month's filed EMP201 has figures, so the EMP501's totals can be checked against their sum (finalise). */
  crossChecked: boolean;
  ready: boolean;
}

const NAMED = 10;

export async function emp501Readiness(companyId: string, p: Emp501Period): Promise<Emp501Readiness> {
  // Scoped to the return's period (coordinator ruling): an interim return judges employees paid March to August only,
  // so a September hire's error blocks the annual return, not the interim one.
  const pv = await preValidateTaxYear(companyId, {
    taxYear: p.taxYear, ...(p.kind === 'interim' ? { throughMonth: p.endYear * 100 + p.endMonth } : {}),
  });
  const withErrors = (pv?.employees ?? []).filter((e) => e.severity === 'error');
  const months = await emp501Months(companyId, p);
  const unfiled = months.filter((m) => m.emp201.kind === 'unfiled').map((m) => m.month);
  const emp201Mismatches = months.flatMap((m) => {
    const d = emp201Differences(m);
    return d.length > 0 ? [`${monthName(m.month)}: ${d.join(', ')}`] : [];
  });
  const driftedEmp201Months: string[] = [];
  for (const m of months) {
    if (m.emp201.kind !== 'version') continue;
    let drifted: boolean;
    try {
      drifted = (await driftOf(companyId, m.emp201.version)).drifted;
    } catch (err) {
      // The EMP201's own run-kind guard refused a run of the month (review #1568 round 2 L): say which month's check it was.
      if (!isRunKindUnsupported(err)) throw err;
      throw new ReturnRefusal(409, `EMP501 can't be finalised: the ${monthName(m.month)} EMP201 check refused this run (${err.message})`,
        err.code, { month: m.month, action: err.action, reasons: err.reasons });
    }
    if (drifted) driftedEmp201Months.push(m.month);
  }
  const uncompared = months.filter((m) => m.emp201.kind === 'legacy' && m.emp201.totals === null).map((m) => m.month);
  const warnings = [
    ...(await notFinalRunMonths(companyId, p)).map((m) => `${monthName(m)} has a run that is not final`),
    ...uncompared.map((m) => `EMP201 for ${monthName(m)} was filed before figures were stored; not cross-checked`),
  ];
  const validationErrors = pv?.errors ?? 0;
  return {
    validationErrors,
    employeesWithErrors: withErrors.slice(0, NAMED).map((e) => e.name),
    codeReleaseLoaded: pv?.codeReleaseLoaded ?? false,
    unfiledEmp201Months: unfiled,
    emp201Mismatches,
    driftedEmp201Months,
    warnings,
    crossChecked: months.every((m) => filedTotals(m.emp201) !== null),
    ready: validationErrors === 0 && unfiled.length === 0 && emp201Mismatches.length === 0 && driftedEmp201Months.length === 0,
  };
}

/** 409 EMP501_NOT_READY naming what blocks it; the readiness otherwise. */
export async function assertEmp501Ready(companyId: string, p: Emp501Period): Promise<Emp501Readiness> {
  const r = await emp501Readiness(companyId, p);
  if (r.ready) return r;
  const parts: string[] = [];
  if (r.validationErrors > 0) {
    parts.push(`IRP5 pre-validation has ${r.validationErrors} error${r.validationErrors === 1 ? '' : 's'} `
      + `(${r.employeesWithErrors.join(', ')}${r.employeesWithErrors.length < r.validationErrors ? ', …' : ''})`
      + `${r.codeReleaseLoaded ? '' : '; no SARS source-code release is loaded for this tax year'}`);
  }
  if (r.unfiledEmp201Months.length > 0) parts.push(`the EMP201 for ${r.unfiledEmp201Months.join(', ')} is not filed`);
  if (r.emp201Mismatches.length > 0) parts.push(`the filed EMP201 does not match the certificates (${r.emp201Mismatches.join('; ')}): amend and file it again`);
  if (r.driftedEmp201Months.length > 0) {
    parts.push(`the payroll changed after the EMP201 for ${r.driftedEmp201Months.join(', ')} was filed: amend and file it again`);
  }
  throw new ReturnRefusal(409, `This EMP501 cannot be finalised: ${parts.join('; and ')}. Fix these first.`, EMP501_NOT_READY,
    { validationErrors: r.validationErrors, unfiledEmp201Months: r.unfiledEmp201Months, emp201Mismatches: r.emp201Mismatches,
      driftedEmp201Months: r.driftedEmp201Months });
}

/**
 * The EMP501's totals (its certificates) must equal the sum of the period's filed EMP201s (review #1568 round 2 M): PAYE
 * on an EMP201 that no certificate carries (a directive naming no employee, an employee with no certificate) refuses.
 */
export async function assertEmp501MatchesFiledEmp201s(companyId: string, p: Emp501Period, totals: MonthTotals): Promise<void> {
  const filed = await filedEmp201PeriodTotals(companyId, p);
  const diffs = (['paye', 'uif', 'sdl'] as const)
    .filter((k) => Math.abs(filed[k] - totals[k]) > 0.01)
    .map((k) => `${k.toUpperCase()} ${filed[k].toFixed(2)} on the filed EMP201s, ${totals[k].toFixed(2)} on the certificates `
      + `(difference ${(totals[k] - filed[k]).toFixed(2)})`);
  if (diffs.length === 0) return;
  throw new ReturnRefusal(409, `This EMP501 cannot be finalised: its totals do not equal the EMP201s filed for the period: ${diffs.join('; ')}. `
    + 'Correct the payroll or the EMP201s first.', EMP501_NOT_READY, { periodTotals: { filed, certificates: { paye: totals.paye, uif: totals.uif, sdl: totals.sdl } } });
}
