/**
 * The particulars block of a payslip (BCEA s33(1)): pure text, so the PDF test reads it without a database.
 * Nothing is invented: a particular payroll has not captured prints "not recorded".
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { Payslip, PayslipRun } from './payslipModel';

export const NOT_RECORDED = 'not recorded';
const MINUS = '−';

/** The app's money format; the true minus is not in the PDF's built-in font, so a negative prints a hyphen. */
export const money = (n: number): string => formatMoney(n).replace(MINUS, '-');
export const shortDate = (d: string | Date | null | undefined): string => formatDisplayDate(d);

/** Address parts joined only when they hold something: ", ," and a lone comma never print. */
export function cleanAddress(raw: string | null | undefined): string {
  return String(raw ?? '').split(/[,\n]/).map((p) => p.trim()).filter((p) => p !== '').join(', ');
}

const num = (n: number | null): string | null => (n == null ? null : String(Number(n)));

export function paidBy(slip: Payslip): string {
  const method = slip.paymentMethod.trim().toLowerCase();
  if (method === 'cash') return 'Cash';
  if (method !== 'eft') return slip.paymentMethod.trim() === '' ? 'Not recorded' : slip.paymentMethod.trim();
  if (!slip.bankLastFour) return 'EFT: bank details missing';
  return `EFT to ${slip.bankName ? `${slip.bankName} ` : ''}•••• ${slip.bankLastFour}`;
}

/** s33(1)(g)/(h): the stored terms of work. They are contracted hours, never presented as hours worked. */
export function ordinaryHours(slip: Payslip): string {
  const week = num(slip.hoursPerWeek);
  const day = num(slip.hoursPerDay);
  if (!week && !day) return NOT_RECORDED;
  return [day ? `${day} per day` : null, week ? `${week} per week` : null].filter(Boolean).join(', ') + ' (contracted)';
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
    ['Income tax number', slip.taxNumber ?? 'Not recorded'],
    ['Pay period', periodLabel],
  ];
  if (run.runDate) facts.push(['Pay date', shortDate(run.runDate)]);
  facts.push(['Paid by', paidBy(slip)]);
  facts.push(['Ordinary hours', ordinaryHours(slip)]);
  if (rate) facts.push(['Rate of pay', rate]);
  facts.push(['Overtime hours', NOT_RECORDED]);
  return facts;
}
