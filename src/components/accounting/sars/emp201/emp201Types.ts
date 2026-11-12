/** EMP201 page data shapes, the default period and the CSV export (moved from pages/accounting/sars/emp201.tsx). */
import { formatMoney } from '@/lib/money/formatMoney';
import { escapeCsv } from '@/lib/csv';
import type { Emp201DirectivePaymentRow } from '@/components/payroll/Emp201DirectivePayments';

export interface EMP201PayrollRun {
  id: string;
  runDate: string;
  employeeCount: number;
  grossPay: number;
  paye: number;
  uif: number;
  sdl: number;
}

/** ETI Act s9(1), s10 (wave 5 ET): payable = PAYE - used; used draws on this period's ETI and the amount brought forward. */
export interface Emp201EtiCarry { broughtForward: number; used: number; carriedForward: number; refundClaimable: number }

export interface EMP201Data {
  periodStart: string;
  periodEnd: string;
  totalPAYE: number;
  totalETI: number;
  payePayable: number;
  etiCarry: Emp201EtiCarry;
  etiWarnings?: string[];
  totalUIF_employee: number;
  totalUIF_employer: number;
  totalUIF: number;
  totalSDL: number;
  employeeCount: number;
  totalTaxableRemuneration: number;
  totalDeductions: number;
  payrollRuns: EMP201PayrollRun[];
  directivePayments?: Emp201DirectivePaymentRow[];
}

export const fmt = (n: number) => formatMoney(n);

export function getDefaultPeriod(): { from: string; to: string } {
  const now = new Date();
  // Default to previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
  const y = prevMonth.getFullYear();
  const m = String(prevMonth.getMonth() + 1).padStart(2, '0');
  return {
    from: `${y}-${m}-01`,
    to: `${y}-${m}-${String(lastDay).padStart(2, '0')}`,
  };
}

export function exportEmp201Csv(data: EMP201Data, from: string, to: string): void {
  const rows = [
    ['Field', 'Description', 'Amount (ZAR)'],
    ['PAYE', 'Total PAYE withheld', data.totalPAYE.toFixed(2)],
    ['ETI', 'Employment Tax Incentive for the period', data.totalETI.toFixed(2)],
    ['ETI brought forward', 'Unused ETI from earlier months (ETI Act s9(1))', data.etiCarry.broughtForward.toFixed(2)],
    ['ETI used', 'ETI set off against PAYE', data.etiCarry.used.toFixed(2)],
    ['ETI carried forward', 'Unused ETI for the next month', data.etiCarry.carriedForward.toFixed(2)],
    ['ETI refund claimable', 'Unused ETI at the end of August or February: claimed on the EMP501 (s10)', data.etiCarry.refundClaimable.toFixed(2)],
    ['PAYE Payable', 'PAYE net of ETI used', data.payePayable.toFixed(2)],
    ['UIF (Employee)', 'UIF employee contribution', data.totalUIF_employee.toFixed(2)],
    ['UIF (Employer)', 'UIF employer contribution', data.totalUIF_employer.toFixed(2)],
    ['UIF Total', 'Total UIF', data.totalUIF.toFixed(2)],
    ['SDL', 'Skills Development Levy', data.totalSDL.toFixed(2)],
    ['Employees', 'Number of employees', String(data.employeeCount)],
    ['Remuneration', 'Total taxable remuneration', data.totalTaxableRemuneration.toFixed(2)],
    ['Total', 'Total deductions payable', data.totalDeductions.toFixed(2)],
    [],
    ['Period', `${data.periodStart} to ${data.periodEnd}`],
  ];
  // RFC 4180 (wave 5 ET fold review): a cell holding a comma, quote or newline is quoted with inner quotes doubled, and a
  // leading formula character is neutralised (escapeCsv, @/lib/csv). A plain number passes as itself: it can hold neither,
  // and the formula guard would turn a negative amount into text.
  const cell = (v: string): string => (/^-?\d+(\.\d+)?$/.test(v) ? v : escapeCsv(v));
  const csv = rows.map((r) => r.map(cell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `EMP201_${from}_${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
