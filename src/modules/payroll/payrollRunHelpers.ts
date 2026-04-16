/**
 * Payroll Run Helpers
 * Pure utility functions extracted to keep payrollRunService.ts under 300 lines.
 */

import { SARS_CODES } from './sarsCodes';
import { calculateETI, isEtiEligible, monthsSinceEtiStart } from './payrollEtiService';
import type { SarsBreakdownLine } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface EtiResult { etiAmount: number; etiMonths: number; }

export function computeEti(emp: Row, grossPay: number, periodEnd: string): EtiResult {
  const etiResult = isEtiEligible({
    idNumber: emp.id_number ? String(emp.id_number) : null,
    etiStartDate: emp.eti_employment_start_date ? String(emp.eti_employment_start_date) : null,
    isConnectedPerson: Boolean(emp.eti_is_connected_person),
    periodEnd: new Date(periodEnd),
  });
  if (!etiResult.eligible || !emp.eti_employment_start_date) return { etiAmount: 0, etiMonths: 0 };
  const etiMonths = monthsSinceEtiStart(String(emp.eti_employment_start_date), new Date(periodEnd));
  return { etiAmount: calculateETI(grossPay, etiMonths), etiMonths };
}

export interface SarsBreakdownInput {
  basic: number; basicCode: string;
  travel: number; travelCode: string;
  housing: number; housingCode: string;
  cell: number; cellCode: string;
  other: number; otherCode: string;
  annualBonus: number; bonusCode: string;
  commission: number; commissionCode: string;
  paye: number;
  uifEmployee: number;
  retireFund: number;
  medical: number;
  etiAmount: number;
}

export function buildSarsBreakdown(i: SarsBreakdownInput): SarsBreakdownLine[] {
  const lines: SarsBreakdownLine[] = [];
  const inc = (code: string, desc: string, amount: number) =>
    lines.push({ code, description: SARS_CODES[code]?.description ?? desc, amount, type: 'income' });
  const ded = (code: string, desc: string, amount: number) =>
    lines.push({ code, description: desc, amount, type: 'deduction' });

  if (i.basic > 0) inc(i.basicCode, 'Basic salary', i.basic);
  if (i.travel > 0) inc(i.travelCode, 'Travel allowance', i.travel);
  if (i.housing > 0) inc(i.housingCode, 'Housing', i.housing);
  if (i.cell > 0) inc(i.cellCode, 'Cell allowance', i.cell);
  if (i.other > 0) inc(i.otherCode, 'Other allowances', i.other);
  if (i.annualBonus > 0) inc(i.bonusCode, 'Annual bonus', i.annualBonus);
  if (i.commission > 0) inc(i.commissionCode, 'Commission', i.commission);
  if (i.paye > 0) ded('4001', 'PAYE', i.paye);
  if (i.uifEmployee > 0) ded('4002', 'UIF \u2014 employee', i.uifEmployee);
  if (i.retireFund > 0) ded('4006', 'Retirement fund', i.retireFund);
  if (i.medical > 0) ded('4474', 'Medical aid \u2014 employee', i.medical);
  if (i.etiAmount > 0) lines.push({ code: '6004', description: 'ETI offset', amount: i.etiAmount, type: 'employer' });

  return lines;
}
