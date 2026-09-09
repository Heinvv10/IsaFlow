import Decimal from 'decimal.js';
import { solveInstallment, lookupRate } from './pmt';
import type { LoanInputs, LoanEvent, RatePoint, ScheduleRow } from './types';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const ZERO = new Decimal(0);

// ── Date helpers ──────────────────────────────────────────────────────────────

function addMonths(dateStr: string, months: number): string {
  const parts = dateStr.split('-').map(Number);
  const y = parts[0] as number;
  const m = parts[1] as number;
  const d = parts[2] as number;
  const isEOM = d === new Date(y, m, 0).getDate();
  const totalMonths = y * 12 + m - 1 + months;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  const day = isEOM ? lastDay : Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function calendarMonth(dateStr: string): number {
  return parseInt(dateStr.slice(5, 7), 10);
}

// ── Skip / lump helpers ───────────────────────────────────────────────────────

function isSkipPeriod(date: string, loan: LoanInputs, events: LoanEvent[]): boolean {
  const month = calendarMonth(date);
  if (loan.recurringSkipMonths.includes(month)) return true;
  return events.some((e) => e.kind === 'SKIP' && e.date === date);
}

function lumpForPeriod(date: string, events: LoanEvent[]): Decimal {
  return events
    .filter((e) => e.kind === 'LUMP' && e.date === date && e.amount != null)
    .reduce((sum, e) => sum.plus(e.amount!), ZERO);
}

// ── Installment re-solve guard ────────────────────────────────────────────────

function shouldReprice(
  repriceMode: LoanInputs['repriceMode'],
  rateChanged: boolean,
  afterLump: boolean,
): boolean {
  if (repriceMode === 'FIXED_INSTALLMENT') return false;
  if (repriceMode === 'RESOLVE_EVERY_PERIOD') return true;
  return rateChanged || afterLump;
}

function roundInstallment(d: Decimal): Decimal {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function to6(d: Decimal): number {
  return d.toDecimalPlaces(6).toNumber();
}

function to2(d: Decimal): number {
  return d.toDecimalPlaces(2).toNumber();
}

// ── Main engine ───────────────────────────────────────────────────────────────

export function amortise(
  loan: LoanInputs,
  events: LoanEvent[],
  curve: RatePoint[],
): ScheduleRow[] {
  const principal = new Decimal(loan.principal);
  const residual = new Decimal(loan.residual);
  const sortedEvents = [...events].sort((a, b) => a.date.localeCompare(b.date));

  const totalPeriods = loan.termMonths;
  let balance = principal;
  let installment: Decimal;
  let prevRate: Decimal | null = null;
  let afterLump = false;

  const { rate: initialRate } = lookupRate(curve, addMonths(loan.startDate, 1), loan);
  installment = roundInstallment(
    solveInstallment(initialRate, totalPeriods, balance, residual),
  );

  const rawRows: ScheduleRow[] = [];
  // Track cumulative interest with full Decimal precision for NCA cap
  let cumInterestDecimal = ZERO;
  // Track cumulative OUTPUT interest (2dp rounded) to prevent exceeding principal in output
  let cumInterestOutput = 0;
  let extendedPeriods = 0;
  // EXTEND_TERM pushes the loop bound out once per skipped period. A loan that
  // skips more months than it repays would run for millennia, so cap the
  // extension: five times the contractual term is far beyond any real payment
  // holiday and still terminates promptly.
  const maxExtendedPeriods = totalPeriods * 5;

  for (let p = 1; p <= totalPeriods + extendedPeriods; p++) {
    const date = addMonths(loan.startDate, p);
    const { rate, extrapolated } = lookupRate(curve, date, loan);
    const monthlyRate = rate.div(1200);
    const rateChanged = prevRate !== null && !rate.equals(prevRate);

    if (p > 1 && shouldReprice(loan.repriceMode, rateChanged, afterLump)) {
      const remaining = totalPeriods + extendedPeriods - p + 1;
      if (remaining > 0) {
        installment = roundInstallment(solveInstallment(rate, remaining, balance, residual));
      }
    }

    afterLump = false;
    prevRate = rate;

    const skip = isSkipPeriod(date, loan, sortedEvents);
    const lump = lumpForPeriod(date, sortedEvents);
    const isLastPeriod = p === totalPeriods + extendedPeriods;

    // Interest on opening balance, capped by NCA in-duplum
    let interest = balance.times(monthlyRate);
    let nca_flagged = false;
    const spaceLeft = principal.minus(cumInterestDecimal);
    if (interest.greaterThan(spaceLeft)) {
      interest = spaceLeft.isNegative() ? ZERO : spaceLeft;
      nca_flagged = true;
    }
    cumInterestDecimal = cumInterestDecimal.plus(interest);

    // Output interest — also cap cumulative output to principal (prevents rounding artefacts)
    const rawInterestOut = to2(interest);
    const spaceLeftOutput = loan.principal - cumInterestOutput;
    const interestOut = Math.min(rawInterestOut, Math.max(0, spaceLeftOutput));
    cumInterestOutput += interestOut;

    // Maximum payment without going below residual
    const availableBalance = balance.plus(interest).minus(residual).minus(lump);
    const maxPayable = availableBalance.isNegative() ? ZERO : availableBalance;

    let payment: Decimal;
    if (skip) {
      payment = ZERO;
    } else if (isLastPeriod || installment.greaterThan(maxPayable)) {
      // Last period or balance too low: clear exactly to residual
      payment = maxPayable;
    } else {
      payment = installment;
    }

    const principalPaid = payment.minus(interest);
    const closing = balance.plus(interest).minus(payment).minus(lump);

    rawRows.push({
      period: p,
      date,
      opening: to6(balance),
      rate: to6(rate),
      installment: to2(installment),
      interest: interestOut,
      principal: to2(principalPaid),
      intPortion: interestOut,
      skip,
      payment: to2(payment),
      lump: to2(lump),
      closing: to2(closing),
      stLiability: 0,
      extrapolated,
      nca_flagged,
    });

    // REDUCE_INSTALLMENT: re-solve after lump
    if (lump.greaterThan(0)) {
      afterLump = true;
      if (loan.lumpMode === 'REDUCE_INSTALLMENT') {
        const remaining = totalPeriods + extendedPeriods - p;
        if (remaining > 0) {
          installment = roundInstallment(solveInstallment(rate, remaining, closing, residual));
        }
      }
    }

    if (skip && loan.skipMode === 'EXTEND_TERM') {
      if (extendedPeriods >= maxExtendedPeriods) {
        throw new Error(
          `Loan skips more periods than it repays: term extension exceeded ${maxExtendedPeriods} periods. ` +
          'Reduce recurringSkipMonths or use skipMode MAINTAIN_TERM.',
        );
      }
      extendedPeriods++;
    }

    if (skip && loan.skipMode === 'MAINTAIN_TERM') {
      const remaining = totalPeriods + extendedPeriods - p;
      if (remaining > 0) {
        installment = roundInstallment(solveInstallment(rate, remaining, closing, residual));
      }
    }

    // Round balance to 2dp to match Excel's row-by-row rounding behaviour
    balance = closing.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    // Early termination when balance is at or below residual
    if (closing.lessThanOrEqualTo(residual.plus(0.005))) break;
  }

  // ── stLiability second pass ───────────────────────────────────────────────
  for (let i = 0; i < rawRows.length; i++) {
    const window = rawRows.slice(i, i + 12);
    const stL = window.reduce((s, r) => s + r.payment + r.lump - r.interest, 0);
    const row = rawRows[i];
    if (row) {
      // Current portion can't exceed total outstanding balance
      row.stLiability = Math.max(0, Math.min(stL, row.opening));
    }
  }

  return rawRows;
}
