/**
 * The oracle's earlier-period helpers, moved out of oracleInput.ts unchanged (wave-7 PRA, refactor(split)): a prior's
 * period end, and the priors as the year to date a run's reader would return. oracleInput.ts re-exports priorYearToDate.
 */
import type { PayeYearToDate, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';
import { dayNumber, isoOfDay, PERIOD_DAYS, periodShareOf } from '@/modules/accounting/services/payroll/payFrequencyPeriods';
import type { OraclePriorPeriod } from './oracle';

/** A prior's period end: its start plus the frequency's days (a monthly prior's month end). */
export function priorEnd(p: Pick<OraclePriorPeriod, 'periodStart' | 'frequency'>): string {
  if (p.frequency === 'monthly') {
    const y = Number(p.periodStart.slice(0, 4));
    const m = Number(p.periodStart.slice(5, 7));
    return `${p.periodStart.slice(0, 8)}${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  }
  return isoOfDay(dayNumber(p.periodStart) + PERIOD_DAYS[p.frequency] - 1);
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const sumOf = (xs: readonly number[]): number => round2(xs.reduce((t, x) => t + x, 0));
const RETIREMENT_CODES = ['4001', '4003', '4006'];

/**
 * The earlier periods as the year to date loadPayeYearToDate would return for those stored lines (wave-6 F1), so the
 * engine sees what a real run sees. Each figure is the stored one, summed; the rest are read from the period's
 * components the way the reader reads a line's breakdown (4005 fees, 4001/4003/4006 contributions, taxable 4030
 * donations, SDL-flagged earnings).
 * NAMED LIMITS: `periods` counts a prior with periodicTaxable > 0 (the reader counts pay before deductions, so a prior
 * whose deductions take its periodic pay to nil is no period here); the SDL leviable a prior stored is its SDL pay less
 * its retirement deduction, floored at nil (no donation); no s18A receipt, no 65+ credit and no PAYE-outside-tables
 * prior. uifEmployee, uifLeviable, businessKm, etiRemuneration and etiHours have no year-to-date field yet: they are
 * validated and carried for FQc, OC and RI, not passed.
 * Weekly and fortnightly (FQc): the fold now carries the cases' PAYE (x52 over n, a starter's prior at its share), and
 * uifLeviable / etiRemuneration / etiHours reach the line through its cadence (caseCadence), not the year to date.
 */
export function priorYearToDate(priors: readonly OraclePriorPeriod[], employee?: Pick<PayrollEmployee, 'startDate' | 'endDate'>): PayeYearToDate {
  const amounts = (p: OraclePriorPeriod, keep: (x: OraclePriorPeriod['components'][number]) => boolean) =>
    p.components.filter(keep).reduce((t, x) => t + x.amount, 0);
  const deduction = (codes: string[]) => (p: OraclePriorPeriod) =>
    amounts(p, x => x.type === 'deduction' && codes.includes(x.code));
  const sdlPay = (p: OraclePriorPeriod) => amounts(p, x => x.type === 'earning' && x.sdl);
  const share = (p: OraclePriorPeriod) => (employee
    ? periodShareOf(p.frequency, { start: p.periodStart, end: priorEnd(p) }, employee.startDate, employee.endDate) : 1);
  return {
    // A weekly or fortnightly prior counts the share of its period worked (FQc: a starter's 3 of 7 days = 0.4285).
    periods: priors.filter(p => p.periodicTaxable > 0).reduce((t, p) => t + share(p), 0),
    retirementCapPeriods: priors.reduce((t, p) => t + (p.periodicTaxable > 0 ? share(p) : p.annualPayments > 0 ? 1 : 0), 0),
    periodicTaxable: sumOf(priors.map(p => p.periodicTaxable)),
    annualPayments: sumOf(priors.map(p => p.annualPayments)),
    tablePaye: sumOf(priors.map(p => p.paye)),
    medicalCredit: sumOf(priors.map(p => p.medicalCredit)),
    additionalMedicalCredit: 0,
    medicalSchemeFees: sumOf(priors.map(deduction(['4005']))),
    retirementContributions: sumOf(priors.map(deduction(RETIREMENT_CODES))),
    retirementDeduction: sumOf(priors.map(p => p.retirementDeduction)),
    donations: sumOf(priors.map(p => amounts(p, x => x.type === 'deduction' && x.code === '4030' && x.taxable))),
    donationReceipted: 0,
    donationBase: 0,
    donationDeduction: 0,
    sdlApplicable: sumOf(priors.map(sdlPay)),
    sdlLeviable: sumOf(priors.map(p => Math.max(0, sdlPay(p) - p.retirementDeduction))),
    sdlRetirementDeduction: sumOf(priors.map(p => p.retirementDeduction)),
    sdlDonationDeduction: 0,
  };
}
