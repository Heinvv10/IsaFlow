/**
 * Validation of an `EngineInput` and the integer rates the engine runs on.
 * A malformed input is a caller bug: `EngineInputError` (or, for the
 * assumptions, `AssumptionsDocError`), never a silently wrong forecast.
 * Money bounds (RANGE): each value ≤ MAX_VALUE_CENTS, Σ|all money| ≤
 * MAX_TOTAL_CENTS, so no sum can leave the safe-integer range.
 */
import { ENTITY_TYPE_CODES } from '@/lib/entityTypes';
import { parseAssumptions } from './assumptionsChain';
import type { ThreeWayAssumptions } from './assumptionsSchema';
import { EngineInputError, type EngineInputErrorCode } from './errors';
import { addMonths, daysInMonth, isContiguous, isMonth } from './months';
import { MAX_TOTAL_CENTS, MAX_VALUE_CENTS, PPM, toPpm } from './ratios';
import { BUCKET_KEYS, PNL_BANDS, type EngineInput } from './types';

/** A version is one fiscal year: 1..15 months (`fiscalYearRegistry`). */
export const MAX_VERSION_MONTHS = 15;
export const MAX_LOOKBACK_MONTHS = 36;
export const MAX_LOAN_SCHEDULES = 200;
export const MAX_UNMAPPED_ACCOUNTS = 2000;

const ISO_DATE = /^(\d{4}-(0[1-9]|1[0-2]))-(\d{2})$/;
const ENTITY_TYPES: ReadonlySet<string> = new Set(ENTITY_TYPE_CODES);

/** Σ|money| of the whole input, refused as RANGE once it passes MAX_TOTAL_CENTS. */
class TotalBound {
  private total = 0;
  add(v: number): void {
    this.total += Math.abs(v);
    if (this.total > MAX_TOTAL_CENTS) {
      throw new EngineInputError('RANGE', `Σ|money| exceeds ${MAX_TOTAL_CENTS} cents (MAX_TOTAL_CENTS)`);
    }
  }
}

function cents(code: EngineInputErrorCode, what: string, v: unknown, total: TotalBound): void {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new EngineInputError(code, `${what} is not whole cents: ${String(v)}`);
  if (Math.abs(v) > MAX_VALUE_CENTS) throw new EngineInputError('RANGE', `${what} exceeds ${MAX_VALUE_CENTS} cents (MAX_VALUE_CENTS): ${v}`);
  total.add(v);
}

function isIsoDate(d: unknown): boolean {
  const hit = typeof d === 'string' ? ISO_DATE.exec(d) : null;
  return hit !== null && Number(hit[3]) >= 1 && Number(hit[3]) <= daysInMonth(hit[1] as string);
}

function validateLists(input: EngineInput, total: TotalBound): void {
  const { months } = input;
  const lb = input.lookback;
  if (lb.length > MAX_LOOKBACK_MONTHS) throw new EngineInputError('LOOKBACK', `lookback holds at most ${MAX_LOOKBACK_MONTHS} months`);
  if (lb.length > 0) {
    const ms = lb.map(l => l.month);
    if (!ms.every(isMonth) || !isContiguous(ms) || ms[ms.length - 1] !== addMonths(months[0] as string, -1)) {
      throw new EngineInputError('LOOKBACK', 'lookback must be contiguous months ending the month before the first month');
    }
    lb.forEach((l, i) => {
      cents('LOOKBACK', `lookback[${i}].turnover`, l.turnover, total);
      cents('LOOKBACK', `lookback[${i}].costOfSales`, l.costOfSales, total);
      cents('LOOKBACK', `lookback[${i}].supplierPurchases`, l.supplierPurchases, total);
    });
  }

  if (!isIsoDate(input.opening.asAt)) throw new EngineInputError('OPENING', `opening.asAt is not a 'YYYY-MM-DD' date: ${String(input.opening.asAt)}`);
  BUCKET_KEYS.forEach(k => cents('OPENING', `opening.${k}`, input.opening.buckets[k], total));
  const unmapped = input.opening.unmapped ?? [];
  if (unmapped.length > MAX_UNMAPPED_ACCOUNTS) throw new EngineInputError('OPENING', `opening.unmapped holds at most ${MAX_UNMAPPED_ACCOUNTS} accounts`);
  // Unmapped balances are already inside the buckets: range-checked, not added to the total twice.
  for (const u of unmapped) cents('OPENING', `unmapped ${u.accountCode}`, u.balance, new TotalBound());

  if (input.loanSchedules.length > MAX_LOAN_SCHEDULES) throw new EngineInputError('LOAN_SCHEDULE', `At most ${MAX_LOAN_SCHEDULES} loan schedules`);
  const ids = new Set<string>();
  for (const s of input.loanSchedules) {
    if (ids.has(s.loanId)) throw new EngineInputError('LOAN_SCHEDULE', `Duplicate loan schedule ${s.loanId}`);
    ids.add(s.loanId);
    if (s.lines.length > months.length) throw new EngineInputError('LOAN_SCHEDULE', `Loan ${s.loanId}: at most ${months.length} lines (one per version month)`);
    for (const l of s.lines) {
      if (!isMonth(l.month)) throw new EngineInputError('LOAN_SCHEDULE', `Loan ${s.loanId}: bad month ${String(l.month)}`);
      cents('LOAN_SCHEDULE', `loan ${s.loanId} principal`, l.principal, total);
      cents('LOAN_SCHEDULE', `loan ${s.loanId} interest`, l.interest, total);
    }
  }

  const dep = input.checks?.assetRegisterDepreciation;
  if (dep) {
    if (dep.length !== months.length) throw new EngineInputError('CHECKS', 'assetRegisterDepreciation must align with months');
    dep.forEach((v, i) => cents('CHECKS', `assetRegisterDepreciation[${i}]`, v, total));
  }
}

/** Assumption money joins the total; an existing loan id may not reuse a planned id. */
function validateAssumptionMoney(a: ThreeWayAssumptions, total: TotalBound): void {
  for (const c of a.capex) total.add(c.amountExVat);
  for (const l of a.loans.planned) total.add(l.principal);
  for (const x of a.equity.shareIssues) total.add(x.amount);
  for (const d of a.equity.dividends) total.add(d.amount);
  total.add(a.minimumCash.value);
  const planned = new Set(a.loans.planned.map(l => l.id));
  const clash = a.loans.existing.find(l => planned.has(l.loanId));
  if (clash) throw new EngineInputError('LOAN_SCHEDULE', `Loan id ${clash.loanId} is both an existing and a planned loan`);
}

/** Throws on any malformed part; returns the re-validated assumptions. */
export function validateEngineInput(input: EngineInput): ThreeWayAssumptions {
  const { months } = input;
  if (months.length < 1 || months.length > MAX_VERSION_MONTHS) {
    throw new EngineInputError('MONTHS', `A version has 1..${MAX_VERSION_MONTHS} months, got ${months.length}`);
  }
  if (!months.every(isMonth) || !isContiguous(months)) throw new EngineInputError('MONTHS', "Months must be contiguous 'YYYY-MM'");
  if (!ENTITY_TYPES.has(input.entityType)) throw new EngineInputError('ENTITY', `Unknown entity type: ${String(input.entityType)}`);
  if (input.pnl.length !== months.length) throw new EngineInputError('PNL', 'pnl must align with months');
  const total = new TotalBound();
  input.pnl.forEach((p, i) => PNL_BANDS.forEach(b => cents('PNL', `pnl[${i}].${b}`, p[b], total)));
  validateLists(input, total);
  const a = parseAssumptions(input.assumptions);
  validateAssumptionMoney(a, total);
  return a;
}

/** The assumptions as the integers the engine computes with. */
export interface EngineRates {
  registered: boolean;
  paymentBasis: boolean;
  /** Standard-rated shares, ppm; 0 when not VAT-registered. */
  salesSharePpm: number;
  purchasesSharePpm: number;
  /** Full-rate share for capex (claimable capex is fully standard-rated). */
  capexSharePpm: number;
  statutorySharePpm: number;
  debtorDays: number;
  creditorDays: number;
  inventoryDays: number;
  refundLagMonths: number;
}

export function ratesOf(a: ThreeWayAssumptions): EngineRates {
  const registered = a.vat.registered.value;
  return {
    registered,
    paymentBasis: a.vat.basis.value === 'payment',
    salesSharePpm: registered ? toPpm(a.vat.vatableSalesShare.value) : 0,
    purchasesSharePpm: registered ? toPpm(a.vat.vatablePurchasesShare.value) : 0,
    capexSharePpm: registered ? PPM : 0,
    statutorySharePpm: toPpm(a.payroll.statutoryShare.value),
    debtorDays: a.workingCapital.debtorDays.value,
    creditorDays: a.workingCapital.creditorDays.value,
    inventoryDays: a.workingCapital.inventoryDays.value,
    refundLagMonths: a.vat.refundLagMonths.value,
  };
}
