import Decimal from 'decimal.js';
import { canonicalMoney } from '../controls/canonical';
import { isRealCalendarDate } from '@/lib/validation';

const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
const money = (value: string) => new D(canonicalMoney(value));
const text = (value: Decimal) => canonicalMoney(value.toFixed());
const cents = (value: Decimal) => value.toDecimalPlaces(2);
export interface ExactPostingLine { glAccountId: string; debit: string; credit: string }

/** Source balance is debit minus credit; closing reverses each P&L balance. */
export function buildExactClosingPlan(accounts: readonly { id: string; balance: string }[], retainedId: string): ExactPostingLine[] {
  if (accounts.length > 10000 || !retainedId || new Set(accounts.map(a => a.id)).size !== accounts.length
    || accounts.some(a => !a.id || a.id === retainedId)) throw new Error('Invalid closing account population');
  let total = new D(0);
  const lines: ExactPostingLine[] = [];
  for (const account of accounts) {
    const balance = money(account.balance);
    if (balance.isZero()) continue;
    total = total.add(balance);
    lines.push({ glAccountId: account.id, debit: balance.isNegative() ? text(balance.neg()) : '0',
      credit: balance.isPositive() ? text(balance) : '0' });
  }
  if (!total.isZero()) lines.push({ glAccountId: retainedId, debit: total.isPositive() ? text(total) : '0',
    credit: total.isNegative() ? text(total.neg()) : '0' });
  return lines;
}

export interface ExactDepreciationInput {
  cost: string; residualPct: string; usefulLifeYears: string; taxLifeYears: string;
  openingAccDep: string; taxOpeningAccDep: string; deferredTaxRate: string;
  purchaseDate: string; periodDate: string; disposalDate?: string;
  salvageValue?: string;
}
/** Decimal adaptation of the existing dual-track engine; no new statutory policy is inferred. */
export function calculateExactDepreciation(input: ExactDepreciationInput) {
  for (const date of [input.purchaseDate, input.periodDate, ...(input.disposalDate ? [input.disposalDate] : [])]) {
    if (!isRealCalendarDate(date)) throw new Error('Invalid depreciation date');
  }
  const cost = money(input.cost), opening = money(input.openingAccDep), taxOpening = money(input.taxOpeningAccDep);
  const residual = money(input.residualPct), life = money(input.usefulLifeYears), taxLife = money(input.taxLifeYears), rate = money(input.deferredTaxRate);
  if (!cost.gt(0) || opening.lt(0) || taxOpening.lt(0) || opening.gt(cost) || taxOpening.gt(cost)
    || residual.lt(0) || residual.gt(1) || rate.lt(0) || rate.gt(1) || !life.gt(0) || !taxLife.gt(0)) {
    throw new Error('Invalid depreciation source values');
  }
  const salvage = input.salvageValue === undefined ? cost.mul(residual) : money(input.salvageValue);
  if (salvage.lt(0) || salvage.gt(cost)) throw new Error('Invalid asset salvage value');
  const depreciable = cents(cost.sub(salvage));
  const annual = cents(depreciable.div(life)), taxAnnual = cents(cost.div(taxLife));
  let policy = cents(annual.div(12)), tax = cents(taxAnnual.div(12));
  const periodMonth = input.periodDate.slice(0, 7), purchaseMonth = input.purchaseDate.slice(0, 7);
  if (periodMonth === purchaseMonth) {
    const [year, month] = input.periodDate.split('-').map(Number);
    const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
    policy = cents(policy.mul(days - Number(input.purchaseDate.slice(8)) + 1).div(days));
  }
  if (periodMonth <= purchaseMonth) tax = new D(0);
  policy = D.max(0, D.min(policy, cents(depreciable.sub(opening))));
  tax = D.max(0, D.min(tax, cents(cost.sub(taxOpening))));
  if (input.purchaseDate > input.periodDate || (input.disposalDate && input.disposalDate <= input.periodDate)) {
    policy = new D(0); tax = new D(0);
  }
  const policyClosing = cents(opening.add(policy)), taxClosing = cents(taxOpening.add(tax));
  const policyCarrying = cents(cost.sub(policyClosing)), taxCarrying = cents(cost.sub(taxClosing));
  return { policyDep: text(policy), taxDep: text(tax), policyClosing: text(policyClosing), taxClosing: text(taxClosing),
    policyCarrying: text(policyCarrying), taxCarrying: text(taxCarrying),
    annualDep: text(annual), policyRate: text(cents(annual.div(cost).mul(100)).div(100)),
    deferredTax: text(cents(taxCarrying.sub(policyCarrying).mul(rate))) };
}
