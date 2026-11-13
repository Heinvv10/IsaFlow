/**
 * Validation of an `EngineInput` and the integer rates the engine runs on.
 * A malformed input is a caller bug: `EngineInputError` (or, for the
 * assumptions, `AssumptionsDocError`), never a silently wrong forecast.
 */
import { isCents } from '@/modules/accounting/services/budgets/grid/cents';
import { parseAssumptions } from './assumptionsChain';
import type { ThreeWayAssumptions } from './assumptionsSchema';
import { EngineInputError, type EngineInputErrorCode } from './errors';
import { addMonths, isContiguous, isMonth } from './months';
import { PPM, toPpm } from './ratios';
import { BUCKET_KEYS, PNL_BANDS, type EngineInput } from './types';

/** A version is one fiscal year: 1..15 months (`fiscalYearRegistry`). */
export const MAX_VERSION_MONTHS = 15;

function cents(code: EngineInputErrorCode, what: string, v: unknown): void {
  if (typeof v !== 'number' || !isCents(v)) throw new EngineInputError(code, `${what} is not whole cents in range: ${String(v)}`);
}

/** Throws on any malformed part; returns the re-validated assumptions. */
export function validateEngineInput(input: EngineInput): ThreeWayAssumptions {
  const { months } = input;
  if (months.length < 1 || months.length > MAX_VERSION_MONTHS) {
    throw new EngineInputError('MONTHS', `A version has 1..${MAX_VERSION_MONTHS} months, got ${months.length}`);
  }
  if (!months.every(isMonth) || !isContiguous(months)) throw new EngineInputError('MONTHS', "Months must be contiguous 'YYYY-MM'");
  if (input.pnl.length !== months.length) throw new EngineInputError('PNL', 'pnl must align with months');
  input.pnl.forEach((p, i) => PNL_BANDS.forEach(b => cents('PNL', `pnl[${i}].${b}`, p[b])));

  const lb = input.lookback;
  if (lb.length > 0) {
    const ms = lb.map(l => l.month);
    if (!ms.every(isMonth) || !isContiguous(ms) || ms[ms.length - 1] !== addMonths(months[0] as string, -1)) {
      throw new EngineInputError('LOOKBACK', 'lookback must be contiguous months ending the month before the first month');
    }
    lb.forEach((l, i) => {
      cents('LOOKBACK', `lookback[${i}].turnover`, l.turnover);
      cents('LOOKBACK', `lookback[${i}].costOfSales`, l.costOfSales);
      cents('LOOKBACK', `lookback[${i}].supplierPurchases`, l.supplierPurchases);
    });
  }

  BUCKET_KEYS.forEach(k => cents('OPENING', `opening.${k}`, input.opening.buckets[k]));
  for (const u of input.opening.unmapped ?? []) cents('OPENING', `unmapped ${u.accountCode}`, u.balance);

  for (const s of input.loanSchedules) {
    for (const l of s.lines) {
      if (!isMonth(l.month)) throw new EngineInputError('LOAN_SCHEDULE', `Loan ${s.loanId}: bad month ${String(l.month)}`);
      cents('LOAN_SCHEDULE', `loan ${s.loanId} principal`, l.principal);
      cents('LOAN_SCHEDULE', `loan ${s.loanId} interest`, l.interest);
    }
  }

  const dep = input.checks?.assetRegisterDepreciation;
  if (dep) {
    if (dep.length !== months.length) throw new EngineInputError('CHECKS', 'assetRegisterDepreciation must align with months');
    dep.forEach((v, i) => cents('CHECKS', `assetRegisterDepreciation[${i}]`, v));
  }
  return parseAssumptions(input.assumptions);
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
