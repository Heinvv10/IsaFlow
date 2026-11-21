/**
 * An off-cycle line's month (wave 6 OC). A bonus or termination run supplements its month's regular run, and two of the
 * statutory figures are MONTHLY figures that the month's runs share, so the off-cycle line carries only what the month
 * adds to what its earlier final lines (the regular run, any earlier off-cycle run) already took:
 *
 *  - UIF: UIC Act 4 of 2002 s6(1): 1% each of the remuneration paid "during the month"; s6(2): not on remuneration
 *    above the ceiling "during any month" (coordinator ruling 2026-11-16 06:40: capped on the month-to-date
 *    REMUNERATION across the month's runs). So this line levies UIF only on the room the month's earlier lines left
 *    under the ceiling (offCycleUif): the month's liability, rounded once, less what the earlier lines booked. Spec F12 as
 *    ruled: this cross-run cap is for a monthly employee's off-cycle runs.
 *  - ETI: Employment Tax Incentive Act 26 of 2013 s7(1)-(3): the incentive is a monthly amount on the employee's
 *    "monthly remuneration" (s1: the remuneration paid in the month), and s7(5) apportions it by the hours of the
 *    month. So the month's ETI is recomputed on everything the month paid (the earlier lines' earnings, rebuilt from
 *    their stored breakdown, plus this line's) and the line carries the difference from what the earlier lines
 *    claimed. Above the s7 table's flat band the incentive falls as remuneration rises, so a bonus can make the
 *    difference NEGATIVE: the month's over-claim reversed on this line (the EMP201 nets it in the month's ETI).
 *
 * Pure. The earlier lines are read by payrollOffCycleMonthRead.ts.
 */
import type { EmployeeComponent, UifResult } from './payrollTypes';
import type { EmploymentClassification } from './employmentTerms';
import { getTaxYearConfig } from './taxTables';
import { UIF_RATE } from './uifEngine';
import { formatMoney } from '@/lib/money/formatMoney';

/**
 * An earlier line's class as stored, strongest first when the month holds several (storedClass). A known flat line
 * beats a directive line, whose real class is unknown (review L1 of e8a2d72dbc).
 */
export type StoredClass = 'undetermined' | 'directive' | 'flat' | 'tables';
export const STORED_CLASS_ORDER: readonly StoredClass[] = ['undetermined', 'flat', 'directive', 'tables'];

/** The stronger of two stored classes (STORED_CLASS_ORDER): the month's lines together. */
export const strongestStoredClass = (a?: StoredClass, b?: StoredClass): StoredClass =>
  STORED_CLASS_ORDER.find((c) => c === a || c === b) ?? 'tables';

/** What the month's earlier final lines of the employee hold (all of them summed; none = zeros and no components). */
export interface MonthEarlierLines {
  /** The UIF remuneration those lines levied on (uifEngine's month to date), rebuilt from their breakdown. */
  uifRemuneration: number;
  /**
   * The UIF those lines actually booked, each side, as stored (review #1679 codex 1): what was withheld and charged,
   * whatever the breakdown can rebuild (an imported line has none). Absent: taken as 1% of uifRemuneration (fixtures).
   */
  uifEmployee?: number;
  uifEmployer?: number;
  eti: number;
  /** The earnings those lines paid, rebuilt from their stored breakdown: the month's ETI base, hours and wage. */
  etiComponents: EmployeeComponent[];
  /** Gross pay of earlier lines whose breakdown rebuilds no earning (an imported line): their ETI base is unknown. */
  unrebuiltPay?: number;
  /**
   * An earlier line costed before the onceOff marker whose once-off basic pay could not be told from its recurring pay
   * (gate ruling 1 on e0eec1dea1): its own class as stored, which the off-cycle line takes rather than reclassifying
   * (review L2 of f37f0f15a6): undetermined (EMPLOYMENT_UNDETERMINED on it), costed under a regular-pay directive, flat
   * (PAYE outside the tables at 25%), else the tables.
   */
  storedClass?: StoredClass;
}

export const NO_EARLIER_LINES: MonthEarlierLines = { uifRemuneration: 0, eti: 0, etiComponents: [] };

/** The class of the month's regular line as stored (storedClass), as the classifier states one. */
export function storedClassification(stored: StoredClass): EmploymentClassification {
  const as = 'Classified as the month\'s regular line was';
  switch (stored) {
    case 'undetermined':
      return { kind: 'undetermined', reason: `${as}: G21 p. 28 could not say whether the employment is standard.`, hoursNotRecorded: false };
    case 'flat':
      return { kind: 'non_standard_flat', reason: `${as}: non-standard employment (G21 p. 28).`, hoursNotRecorded: false };
    case 'directive':
      return { kind: 'standard', reason: `${as}: under a regular-pay tax directive, so not reclassified on its rebuilt pay.`, hoursNotRecorded: false };
    default:
      return { kind: 'standard', reason: `${as}: taxed on the tables.`, hoursNotRecorded: false };
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Each side's figure, employee and employer. */
export interface UifSides { employee: number; employer: number }

/**
 * This line's UIF (review #1679 codex 1 and 2, and the payroll review of 5600db089c): the month's liability, 1% of the
 * month-to-date remuneration up to the ceiling and rounded ONCE, less what the earlier lines booked, each side, never
 * below nil. So the month never levies more than 1% of the ceiling (R10 001.50 then R7 710.50: R100.02 then R77.10, not
 * R77.11). The earlier remuneration, each side, is the larger of the one rebuilt from the breakdown and the one the
 * stored contribution implies (booked ÷ 1%), the latter only where the booked UIF exceeds what the rebuilt pay explains
 * (fix check L1: a booked cent of rounding is not R0.50 of pay): an imported line with no breakdown that withheld R50
 * levied on R5 000, so a R5 000 bonus owes R50, not nil, and one that withheld R177.12 leaves the bonus nil. Each side's
 * month to date, leviable and cap are its own (`sides`, fix check L2); `monthToDate`, `leviable` and `isCapped` are
 * the larger side's, for the line's single record.
 */
export function offCycleUif(thisRemuneration: number, earlier: MonthEarlierLines, taxYear: number): {
  uif: UifResult; leviable: number; monthToDate: number; rebuilt: number;
  earlierPay: UifSides; liability: UifSides; booked: UifSides; leviableSides: UifSides; capped: { employee: boolean; employer: boolean };
} {
  const ceiling = getTaxYearConfig(taxYear).uifCeiling;
  const pay = Math.max(0, thisRemuneration);
  const rebuilt = Math.max(0, earlier.uifRemuneration);
  const own = round2(Math.min(rebuilt, ceiling) * UIF_RATE);
  const booked = { employee: earlier.uifEmployee ?? own, employer: earlier.uifEmployer ?? own };
  const earlierOf = (b: number): number => (b > own ? Math.max(rebuilt, round2(b / UIF_RATE)) : rebuilt);
  const earlierPay = { employee: earlierOf(booked.employee), employer: earlierOf(booked.employer) };
  const liabilityOf = (e: number): number => round2(Math.min(e + pay, ceiling) * UIF_RATE);
  const liability = { employee: liabilityOf(earlierPay.employee), employer: liabilityOf(earlierPay.employer) };
  const monthToDate = Math.max(earlierPay.employee, earlierPay.employer);
  const leviableOf = (e: number): number => Math.max(0, Math.min(thisRemuneration, ceiling - e));
  const leviableSides = { employee: leviableOf(earlierPay.employee), employer: leviableOf(earlierPay.employer) };
  const capped = { employee: earlierPay.employee + pay > ceiling, employer: earlierPay.employer + pay > ceiling };
  return {
    uif: {
      employeeContribution: Math.max(0, round2(liability.employee - booked.employee)),
      employerContribution: Math.max(0, round2(liability.employer - booked.employer)),
      isCapped: capped.employee || capped.employer,
    },
    leviable: leviableOf(monthToDate),
    monthToDate, rebuilt, earlierPay, liability, booked, leviableSides, capped,
  };
}

/** Refused at calculation (offCycleEtiRefusal): the month's ETI cannot be costed on the earnings it knows. */
export class OffCycleEtiBasisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffCycleEtiBasisError';
  }
}

/**
 * Why this line's ETI cannot be costed, or null (review of 99db78312): an earlier line paid earnings its breakdown does
 * not rebuild (unrebuiltPay), so the month's ETI recomputed on this line alone would reverse a valid claim or claim in
 * excess. Only where ETI is at stake: the earlier lines claimed some, or the month's recomputed ETI is not nil (an
 * ineligible employee, or a month above the s7 table even on this line alone, stays nil on more pay too).
 */
export function offCycleEtiRefusal(monthEti: number, earlier: MonthEarlierLines, employeeName: string): string | null {
  if ((earlier.unrebuiltPay ?? 0) <= 0 || (earlier.eti === 0 && monthEti === 0)) return null;
  return `${employeeName}'s earlier pay this month (${formatMoney(earlier.unrebuiltPay ?? 0)}) was recorded without its earnings `
    + 'breakdown (an imported line), so the month\'s Employment Tax Incentive cannot be costed on this run. Recalculate the '
    + 'month\'s regular run in IsaFlow first, or pay this amount on the regular run.';
}

/** This line's ETI: the month's, on everything the month paid, less what the earlier lines claimed (may be negative). */
export function offCycleEti(monthEti: number, earlier: MonthEarlierLines): number {
  return round2(monthEti - earlier.eti);
}
