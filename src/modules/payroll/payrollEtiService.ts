/**
 * Employment Tax Incentive (ETI) service — SARS 2025/2026 formula.
 * ETI is an employer-side reduction of the EMP201 PAYE liability;
 * it is NOT deducted from the employee's payslip.
 *
 * Simplified two-band formula used here (matches the approach most SA payroll products use):
 *   Month 1-12:
 *     wage <= 2000 → 1500
 *     2000 < wage < 6500 → 0.5 * (6500 - wage)
 *     wage >= 6500 → 0
 *   Month 13-24: half of the above.
 *   Month 25+: 0.
 */

import { calculateAgeFromIdNumber } from './taxTables';

const ETI_CEILING = 6500;
const ETI_FLOOR_WAGE = 2000;
const ETI_MAX_AMOUNT = 1500;

export function calculateETI(monthlyWage: number, etiMonth: number): number {
  if (etiMonth < 1 || etiMonth > 24) return 0;
  if (monthlyWage >= ETI_CEILING) return 0;
  if (monthlyWage < 0) return 0;

  const firstYearAmount = monthlyWage <= ETI_FLOOR_WAGE
    ? ETI_MAX_AMOUNT
    : 0.5 * (ETI_CEILING - monthlyWage);

  const amount = etiMonth <= 12 ? firstYearAmount : firstYearAmount / 2;
  return Math.round(amount * 100) / 100;
}

export interface EtiEligibilityInput {
  idNumber: string | null;
  etiStartDate: string | null;
  isConnectedPerson: boolean;
  periodEnd: Date;
}

export type EtiEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string };

export function isEtiEligible(input: EtiEligibilityInput): EtiEligibilityResult {
  if (!input.idNumber) return { eligible: false, reason: 'Missing SA ID number' };
  if (input.isConnectedPerson) return { eligible: false, reason: 'Connected person — not ETI-eligible' };
  if (!input.etiStartDate) return { eligible: false, reason: 'Missing ETI employment start date' };

  const age = calculateAgeFromIdNumber(input.idNumber, input.periodEnd);
  if (age < 18) return { eligible: false, reason: 'Age below 18' };
  if (age > 29) return { eligible: false, reason: 'Age above 29' };

  const months = monthsSinceEtiStart(input.etiStartDate, input.periodEnd);
  if (months > 24) return { eligible: false, reason: '24-month ETI window expired' };
  if (months < 1) return { eligible: false, reason: 'ETI start date is in the future' };

  return { eligible: true };
}

export function monthsSinceEtiStart(startDate: string, periodEnd: Date): number {
  const start = new Date(startDate);
  const years = periodEnd.getFullYear() - start.getFullYear();
  const months = periodEnd.getMonth() - start.getMonth();
  return years * 12 + months + 1;
}
