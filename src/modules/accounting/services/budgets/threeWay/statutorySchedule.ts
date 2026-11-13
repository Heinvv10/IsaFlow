/**
 * Statutory cash timing (P6 spec §5 steps 5 and 9, T4).
 *
 * Payroll: the statutory share p of payroll expense (PAYE net of ETI + UIF ee+er
 * + SDL, §13.12) accrues to payroll liabilities and is remitted the month after
 * (EMP201 by the 7th of m+1); the rest is paid in the month.
 *
 * Provisional tax (10b as corrected in §13.1–3), companies only (§13.2):
 * IRP6 #1 = 50 % of the version's FY budgeted tax in FY month 6, only when the
 * year has more than 6 months; IRP6 #2 = the balance in the year's last month;
 * the opening (prior-year) payable is settled in the top-up month, counted from
 * the PRIOR year end: 7 months after a February year end, else 6 (SARS), when
 * that month is inside the version.
 */
import type { EntityTypeCode } from '@/lib/entityTypes';
import { addMonths, monthNumber } from './months';
import { PPM, checkedAdd, mulDiv } from './ratios';
import type { TaxEvent } from './types';

/** Payroll split into the statutory accrual and the net paid now. `net` is the residual, so the two always sum to `payroll`. */
export function payrollSplit(payroll: number, statutorySharePpm: number): { statutory: number; net: number } {
  const statutory = mulDiv(payroll, statutorySharePpm, PPM);
  return { statutory, net: payroll - statutory };
}

const PROVISIONAL_ENTITIES: ReadonlySet<EntityTypeCode> = new Set<EntityTypeCode>(['pty_ltd', 'ltd', 'cc', 'npc']);

/** §13.2: provisional tax is on for pty_ltd, ltd, cc, npc; off for the rest. */
export function provisionalTaxApplies(entityType: EntityTypeCode): boolean {
  return PROVISIONAL_ENTITIES.has(entityType);
}

/** SARS: the top-up falls 7 months after a February year end, 6 after any other. */
export function sarsTopUpOffset(priorYearEnd: string): 6 | 7 {
  return monthNumber(priorYearEnd) === 2 ? 7 : 6;
}

export interface ProvisionalTaxInput {
  /** The version's months (its whole fiscal year, 1..15). */
  months: readonly string[];
  /** Budgeted tax expense per month (natural sign, cents). */
  taxExpense: readonly number[];
  /** Opening income tax payable, credit-positive cents (a debit opening is never "paid"). */
  openingTaxPayable: number;
  topUpOffset: 6 | 7;
}

/** The year's IRP6 and top-up payments, in month order (#1 before a same-month top-up). Zero amounts are omitted. */
export function provisionalTaxSchedule(p: ProvisionalTaxInput): TaxEvent[] {
  const n = p.months.length;
  if (n === 0) return [];
  const fyTax = p.taxExpense.reduce(checkedAdd, 0);
  const events: TaxEvent[] = [];
  const first = n > 6 ? Math.max(0, mulDiv(fyTax, 1, 2)) : 0;
  if (first > 0) events.push({ month: p.months[5] as string, kind: 'irp6_first', amount: first });
  const topUpMonth = addMonths(addMonths(p.months[0] as string, -1), p.topUpOffset);
  if (p.openingTaxPayable > 0 && p.months.includes(topUpMonth)) {
    events.push({ month: topUpMonth, kind: 'top_up', amount: p.openingTaxPayable });
  }
  const second = Math.max(0, fyTax - first);
  if (second > 0) events.push({ month: p.months[n - 1] as string, kind: 'irp6_second', amount: second });
  return events.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}
