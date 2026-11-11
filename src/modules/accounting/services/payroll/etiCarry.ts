/**
 * ETI brought forward, used and carried forward (master plan wave 5, ET): the pure ledger. The EMP201 (reports/emp201Service)
 * and the payroll journal (payrollJournalBuilder) both read it, through etiCarryRead.ts, so they cannot disagree.
 *
 * Sources (ETI Act 26 of 2013 as amended; SARS Guide to the Employment Tax Incentive, Issue 5, 27 July 2026):
 *  - s9(1): ETI above the month's employees' tax is added to the ETI available in the next month (guide §7 p. 46,
 *    Example 19 p. 47: R33 000 ETI against R25 000 PAYE carries R8 000 into the next month).
 *  - The ETI reduces the employer's TOTAL employees' tax for the month, whoever it was withheld from (guide §6.1 p. 42).
 *  - s10(1) and s10(3): at the end of the reconciliation period of Fourth Schedule para 14(3)(a) (the six months ending
 *    August and February, guide §7 p. 46 and §8 p. 48) the excess is claimed as a refund on the EMP501, and is then nil
 *    in the month after: nothing is carried into March or September.
 * NAMED LIMITS: s9(2) (ETI available but not claimed) and s9(3) (ETI held back while the employer is not tax compliant,
 * s8) are not modelled: IsaFlow claims every month's ETI it works out and does not know the employer's compliance status.
 * Whether SARS pays the refund (s10(4)-(6)) is not known here: `refundClaimable` is what may be claimed, not what is paid.
 */

export interface EtiMonth { year: number; month: number; paye: number; eti: number }

export interface EtiCarryMonth extends EtiMonth {
  broughtForward: number;
  available: number;
  used: number;
  carriedForward: number;
  /** The excess at the end of a reconciliation period (August, February): claimed as a refund, not carried (s10). */
  refundClaimable: number;
}

/** The figures for a range of months: brought forward into its first month, used in it, carried out of its last. */
export interface EtiCarry {
  broughtForward: number;
  used: number;
  carriedForward: number;
  refundClaimable: number;
}

export interface YearMonth { year: number; month: number }

export const index = (ym: YearMonth): number => ym.year * 12 + (ym.month - 1);
const fromIndex = (i: number): YearMonth => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });
const cents = (n: number): number => Math.round(n * 100);
const rand = (c: number): number => c / 100;

/** The first month of the reconciliation period holding `ym`: March (for March-August) or September (September-February). */
export function reconciliationStart(ym: YearMonth): YearMonth {
  if (ym.month >= 3 && ym.month <= 8) return { year: ym.year, month: 3 };
  return ym.month >= 9 ? { year: ym.year, month: 9 } : { year: ym.year - 1, month: 9 };
}

/**
 * Month by month from the start of `from`'s reconciliation period to `to`. `months` may hold several entries for one
 * month (runs, directive payments) and need not hold a month at all (nothing paid: the excess carries on through it).
 */
export function etiCarryLedger(from: YearMonth, to: YearMonth, months: EtiMonth[]): EtiCarryMonth[] {
  const sums = new Map<number, { paye: number; eti: number }>();
  for (const m of months) {
    const s = sums.get(index(m)) ?? { paye: 0, eti: 0 };
    sums.set(index(m), { paye: s.paye + cents(m.paye), eti: s.eti + cents(m.eti) });
  }
  const ledger: EtiCarryMonth[] = [];
  let carried = 0;
  for (let i = index(reconciliationStart(from)); i <= index(to); i += 1) {
    const ym = fromIndex(i);
    const { paye, eti } = sums.get(i) ?? { paye: 0, eti: 0 };
    const broughtForward = ym.month === 3 || ym.month === 9 ? 0 : carried;
    const available = eti + broughtForward;
    const used = Math.min(Math.max(paye, 0), available);
    carried = available - used;
    const refundClaimable = ym.month === 2 || ym.month === 8 ? carried : 0;
    ledger.push({
      ...ym, paye: rand(paye), eti: rand(eti), broughtForward: rand(broughtForward), available: rand(available),
      used: rand(used), carriedForward: rand(carried), refundClaimable: rand(refundClaimable),
    });
  }
  return ledger;
}

/** The range's figures from its ledger. */
export function summariseCarry(ledger: EtiCarryMonth[], from: YearMonth): EtiCarry {
  const inRange = ledger.filter((m) => index(m) >= index(from));
  const sum = (f: (m: EtiCarryMonth) => number): number => rand(inRange.reduce((t, m) => t + cents(f(m)), 0));
  return {
    broughtForward: inRange[0]?.broughtForward ?? 0,
    used: sum((m) => m.used),
    carriedForward: inRange[inRange.length - 1]?.carriedForward ?? 0,
    refundClaimable: sum((m) => m.refundClaimable),
  };
}

/** Stored rows (run headers or month sums) and stand-alone directive payments as ledger months: the one mapper. */
export function etiMonthsOf(
  runs: Array<Record<string, unknown>>,
  directives: Array<{ paymentDate: string; paye: number }>,
): EtiMonth[] {
  return [
    ...runs.map((r) => ({ year: Number(r.period_year), month: Number(r.period_month), paye: Number(r.paye) || 0, eti: Number(r.eti) || 0 })),
    ...directives.map((p) => ({ year: Number(p.paymentDate.slice(0, 4)), month: Number(p.paymentDate.slice(5, 7)), paye: p.paye, eti: 0 })),
  ];
}
