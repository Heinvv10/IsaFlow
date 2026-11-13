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
 * catalogue by `componentId` (`componentTypes`). An item whose type is not known
 * (component gone from the catalogue) is never guessed: it is left to "Not itemised".
 * An employer contribution is neither pay nor a deduction: it is listed as the employer's.
 */
import { EMPLOYER_FUND_BENEFIT_CODES } from './retirementFundCodes';
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
  /** The employer's own contributions named in the breakdown: not in gross, not deducted. */
  employerContributions: PayslipItem[];
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
  /**
   * RF: the retirement fund contributions counted for the s11F deduction: the employee's own (4001 / 4003 / 4006, deducted
   * or paid directly) and the employer's non-cash 3817 / 3825 / 3828, deemed paid by the employee (G21 (2027) p. 10). Null
   * when there are none.
   */
  retirementFund: { own: number; employerDeemed: number } | null;
}

export const NOT_ITEMISED = 'Not itemised';
export const BENEFIT_NOTE = 'Taxable benefit, not paid';
export const PAID_DIRECTLY_NOTE = 'Paid by you directly; counted for tax';
/** RF: said beside an employer fund contribution benefit. */
export const DEEMED_FUND_NOTE = 'taxable benefit, also counted as your retirement contribution';
const FUND_BENEFIT_CODES = new Set<string>(EMPLOYER_FUND_BENEFIT_CODES);

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function readBreakdown(raw: unknown): ComponentBreakdownItem[] {
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
  const employerContributions: PayslipItem[] = [];
  let own = 0;
  let employerDeemed = 0;
  for (const raw of readBreakdown(line.breakdown)) {
    const item = itemOf(raw);
    if (item.amount === 0) continue;
    if (raw.retirementContribution === true) own += item.amount;
    // Deemed only as the calculator deems it: a taxable non-cash 3817 / 3825 / 3828 (employerContributions.deemedRetirementContributions).
    if (raw.isNonCash === true && raw.isTaxable === true && FUND_BENEFIT_CODES.has(item.code)) {
      employerDeemed += item.amount;
      item.label = `${item.label} (${DEEMED_FUND_NOTE})`;
    }
    const type = componentTypes.get(String(raw.componentId ?? ''));
    if (type === 'deduction') (raw.paidOutsidePayroll === true ? paidDirectly : deductions).push(item);
    else if (type === 'earning') (raw.isNonCash === true ? benefits : earnings).push(item);
    else if (type === 'employer_contribution') employerContributions.push(item);
    // Unknown type: not guessed. Its amount stays in the stored totals and shows as "Not itemised".
  }

  const grossPay = round2(line.grossPay);
  const otherDeductions = round2(line.grossPay - line.paye - line.uifEmployee - line.netPay);
  const earningGap = round2(grossPay - sum(earnings));
  const deductionGap = round2(otherDeductions - sum(deductions));
  if (earningGap !== 0) earnings.push({ label: NOT_ITEMISED, code: '', amount: earningGap });
  if (deductionGap !== 0) deductions.push({ label: NOT_ITEMISED, code: '', amount: deductionGap });

  return {
    earnings, benefits, deductions, paidDirectly, employerContributions,
    grossPay, paye: round2(line.paye), uifEmployee: round2(line.uifEmployee), otherDeductions,
    netPay: round2(line.netPay), uifEmployer: round2(line.uifEmployer), sdl: round2(line.sdl),
    notItemised: earningGap !== 0 || deductionGap !== 0,
    retirementFund: own !== 0 || employerDeemed !== 0 ? { own: round2(own), employerDeemed: round2(employerDeemed) } : null,
  };
}

const NOTE_MISSING = 'Not itemised: part of a stored total is not broken down into items on the stored pay line '
  + '(for example, it was calculated before items were recorded, or an item\'s component is no longer in the catalogue).';
const NOTE_EXCEEDS = 'Not itemised (negative): the items on the stored pay line add up to more than the stored total '
  + '(for example, net pay was limited to nil when deductions exceeded pay), so the difference is shown as a negative amount.';

/** The slip's footnote for its "Not itemised" lines, worded by cause; null when there are none. */
export function notItemisedNote(slip: Pick<PayslipLines, 'earnings' | 'deductions' | 'notItemised'>): string | null {
  if (!slip.notItemised) return null;
  const gaps = [...slip.earnings, ...slip.deductions].filter((i) => i.label === NOT_ITEMISED && i.code === '');
  const parts = [
    gaps.some((g) => g.amount > 0) ? NOTE_MISSING : null,
    gaps.some((g) => g.amount < 0) ? NOTE_EXCEEDS : null,
  ].filter((p): p is string => p !== null);
  return `${parts.join(' ')} The totals are the stored figures.`;
}
