/**
 * A payslip's lines from ONE stored run line: pure, nothing recalculated (wave 4 PS).
 *
 * Every total is the stored figure: gross, PAYE, employee UIF and net come from
 * `payroll_run_lines`, never from the items. The items only explain them. When the
 * items do not add up to the stored gross, or to the stored other deductions
 * (gross − PAYE − employee UIF − net, the residual the payroll journal credits to
 * 2175), a labelled "Not itemised" line carries the difference and `notItemised` is
 * set, so the slip says so. It is never re-totalled silently (lines from before the
 * breakdown flags existed).
 *
 * The stored breakdown carries no component type. It is read from the company's
 * catalogue by `componentId` (`componentTypes`); an item whose component is gone is
 * a deduction when its SARS code is a 40xx code or LOAN, else an earning.
 */
import type { ComponentBreakdownItem } from './payrollTypes';

export interface PayslipItem {
  label: string;
  code: string;
  amount: number;
}

export interface StoredPayslipLine {
  grossPay: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  netPay: number;
  breakdown: unknown;
}

export interface PayslipLines {
  /** Cash earnings; with the residual, they add up to `grossPay`. */
  earnings: PayslipItem[];
  /** Taxed (and levied) but not paid in cash: "Taxable benefit, not paid". Not in gross or net. */
  benefits: PayslipItem[];
  /** Voluntary deductions taken from pay; with the residual, they add up to `otherDeductions`. */
  deductions: PayslipItem[];
  /** Counted for tax, paid by the employee straight to the fund: not taken from pay. */
  paidDirectly: PayslipItem[];
  grossPay: number;
  paye: number;
  uifEmployee: number;
  /** gross − PAYE − employee UIF − net, from the stored figures. */
  otherDeductions: number;
  netPay: number;
  uifEmployer: number;
  sdl: number;
  /** A "Not itemised" line is on the slip. */
  notItemised: boolean;
}

export const NOT_ITEMISED = 'Not itemised';
export const BENEFIT_NOTE = 'Taxable benefit, not paid';
export const PAID_DIRECTLY_NOTE = 'Paid by you directly; counted for tax';

const round2 = (n: number): number => Math.round(n * 100) / 100;

function readBreakdown(raw: unknown): ComponentBreakdownItem[] {
  const value = typeof raw === 'string' ? parse(raw) : raw;
  return Array.isArray(value) ? (value as ComponentBreakdownItem[]).filter((i) => i && typeof i === 'object') : [];
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // An unreadable breakdown itemises nothing: every figure then shows as "Not itemised".
    return null;
  }
}

function isDeduction(item: ComponentBreakdownItem, componentTypes: ReadonlyMap<string, string>): boolean {
  const type = componentTypes.get(String(item.componentId ?? ''));
  if (type) return type === 'deduction';
  const code = String(item.sarsSourceCode ?? '').trim();
  return code === 'LOAN' || code.startsWith('40');
}

const itemOf = (i: ComponentBreakdownItem): PayslipItem => ({
  label: String(i.componentName ?? '').trim() || 'Unnamed item',
  code: String(i.sarsSourceCode ?? '').trim(),
  amount: round2(Number(i.amount) || 0),
});

const sum = (items: PayslipItem[]): number => round2(items.reduce((s, i) => s + i.amount, 0));

export function itemisePayslip(line: StoredPayslipLine, componentTypes: ReadonlyMap<string, string>): PayslipLines {
  const earnings: PayslipItem[] = [];
  const benefits: PayslipItem[] = [];
  const deductions: PayslipItem[] = [];
  const paidDirectly: PayslipItem[] = [];
  for (const raw of readBreakdown(line.breakdown)) {
    const item = itemOf(raw);
    if (item.amount === 0) continue;
    if (isDeduction(raw, componentTypes)) (raw.paidOutsidePayroll === true ? paidDirectly : deductions).push(item);
    else (raw.isNonCash === true ? benefits : earnings).push(item);
  }

  const grossPay = round2(line.grossPay);
  const otherDeductions = round2(line.grossPay - line.paye - line.uifEmployee - line.netPay);
  const earningGap = round2(grossPay - sum(earnings));
  const deductionGap = round2(otherDeductions - sum(deductions));
  if (earningGap !== 0) earnings.push({ label: NOT_ITEMISED, code: '', amount: earningGap });
  if (deductionGap !== 0) deductions.push({ label: NOT_ITEMISED, code: '', amount: deductionGap });

  return {
    earnings, benefits, deductions, paidDirectly,
    grossPay, paye: round2(line.paye), uifEmployee: round2(line.uifEmployee), otherDeductions,
    netPay: round2(line.netPay), uifEmployer: round2(line.uifEmployer), sdl: round2(line.sdl),
    notItemised: earningGap !== 0 || deductionGap !== 0,
  };
}
