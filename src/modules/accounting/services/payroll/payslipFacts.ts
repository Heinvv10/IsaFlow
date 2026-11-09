/**
 * The particulars block of a payslip (BCEA s33(1)): pure text, so the PDF test reads it without a database.
 * Nothing is invented: a particular payroll has not captured prints "not recorded".
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { Payslip, PayslipRun } from './payslipModel';
import type { WorkedQuantity } from './payslipQuantities';

export const NOT_RECORDED = 'Not recorded';
const MINUS = '−';

/** The app's money format; the true minus is not in the PDF's built-in font, so a negative prints a hyphen. */
export const money = (n: number): string => formatMoney(n).replace(MINUS, '-');
export const shortDate = (d: string | Date | null | undefined): string => formatDisplayDate(d);

/** Address parts joined only when they hold something: ", ," and a lone comma never print. */
export function cleanAddress(raw: string | null | undefined): string {
  return String(raw ?? '').split(/[,\n]/).map((p) => p.trim()).filter((p) => p !== '').join(', ');
}

const num = (n: number | null): string | null => (n == null ? null : String(Number(n)));

const capitalised = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

export function paidBy(slip: Payslip): string {
  const raw = slip.paymentMethod.trim();
  const method = raw.toLowerCase();
  if (method === '') return NOT_RECORDED;
  if (method === 'cash') return 'Cash';
  if (method !== 'eft') return capitalised(raw);
  if (slip.bankIncomplete) return 'EFT: bank details incomplete';
  if (!slip.bankLastFour) return 'EFT: bank details missing';
  return `EFT to ${slip.bankName ? `${slip.bankName} ` : ''}\u2022\u2022\u2022\u2022 ${slip.bankLastFour}`;
}

/** "40 hours", "1 day": a figure captured on the run, printed as captured. */
export function workedText(q: WorkedQuantity): string {
  return `${q.quantity} ${q.unit}${q.quantity === 1 ? '' : 's'}`;
}

/**
 * s33(1)(g), hours relevant to the calculation: what was captured on the run is printed as worked; the stored
 * terms of work follow, labelled "contracted", never presented as hours worked. Nothing of either: "Not recorded".
 */
export function ordinaryHours(slip: Payslip): string {
  const week = num(slip.hoursPerWeek);
  const day = num(slip.hoursPerDay);
  const parts: string[] = [];
  if (slip.workedOrdinary) parts.push(`${workedText(slip.workedOrdinary)} worked`);
  if (week || day) parts.push(`${[day ? `${day} per day` : null, week ? `${week} per week` : null].filter(Boolean).join(', ')} (contracted)`);
  return parts.length > 0 ? parts.join('; ') : NOT_RECORDED;
}

export function overtimeHours(slip: Payslip): string {
  return slip.workedOvertime ? workedText(slip.workedOvertime) : NOT_RECORDED;
}

export function rateOfPay(slip: Payslip): string | null {
  if (slip.payBasis === 'hourly' && slip.hourlyRate != null) return `${money(slip.hourlyRate)} per hour`;
  if (slip.payBasis === 'daily' && slip.dailyRate != null) return `${money(slip.dailyRate)} per day`;
  return null;
}

export function particulars(run: PayslipRun, slip: Payslip, periodLabel: string): Array<[string, string]> {
  const rate = rateOfPay(slip);
  const facts: Array<[string, string]> = [
    ['Employee', `${slip.employeeName} (${slip.employeeNumber})`],
    ['Occupation', slip.occupation?.trim() || NOT_RECORDED],
    ['Income tax number', slip.taxNumber?.trim() || NOT_RECORDED],
    ['Pay period', periodLabel],
  ];
  if (run.runDate) facts.push(['Pay date', shortDate(run.runDate)]);
  facts.push(['Paid by', paidBy(slip)]);
  facts.push(['Ordinary hours', ordinaryHours(slip)]);
  if (rate) facts.push(['Rate of pay', rate]);
  facts.push(['Overtime hours', overtimeHours(slip)]);
  return facts;
}
