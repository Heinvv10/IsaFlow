/**
 * Derived default assumptions (P6 spec §4 "Derived defaults", decision 10),
 * PURE. The DB adapter (`deriveAssumptions.ts`) gathers the figures; this
 * computes the document from them and never writes.
 *
 * - Days, VAT-inclusive basis, over the trailing window of history months
 *   (`window`: the months, oldest first, from the first month with posted P&L
 *   activity, at most 12, ending on or before the opening as-at):
 *     debtorDays    = AR(open) ÷ Σ turnover × (1 + s_out·rate) × Σ days
 *     creditorDays  = AP(open) ÷ Σ (purchases + supplier opex) × (1 + s_in·rate) × Σ days
 *     inventoryDays = inventory(open) ÷ Σ cost of sales × Σ days; 0 when no inventory account is held
 *   clamped to the schema bounds, 2 dp. Fewer than 3 history months: 30/30/0,
 *   `basis: 'insufficient history'` (the defaults document's values).
 * - vatableSalesShare = output VAT ÷ (turnover × rate), purchases likewise
 *   (input VAT includes capital goods, so a capex-heavy window over-states it:
 *   the clamp to 0..1 is the guard), 4 dp. Not registered or no base: 1.
 * - statutoryShare = (PAYE net of ETI + UIF + SDL) of the last 3 months ÷ the
 *   payroll expense of the same months; no payroll → 0.
 * - Payable accounts (spec §5): when exactly ONE active leaf liability account's name matches
 *   /income tax|provisional tax|SARS.*tax/i it is proposed as `incomeTax.payableAccountId`
 *   (/dividend/i: `equity.dividendsPayableAccountId`); none or several: none proposed. The
 *   fields carry no provenance, so the basis text is in `evidence.payableAccounts`.
 * - VAT settings come from the company row, already normalised by the
 *   adapter (`vatPeriodHelper`); a NULL/blank `vat_period` defaults to
 *   bi-monthly and says so (§13.11).
 */
import type { EntityTypeCode } from '@/lib/entityTypes';
import { defaultAssumptions } from './assumptionsDefaults';
import type { Prov, ThreeWayAssumptions } from './assumptionsSchema';
import { derivedDays } from './daysMethod';
import { daysInMonth } from './months';
import { SA_STANDARD_RATE_BP, toPpm, vatOnNet } from './ratios';
import type { LiabilityAccount } from './payableAccounts';
import type { ActualMonth } from './threeWayFolds';
import type { VatAlignment, VatCadence } from './vatSchedule';

/** History months needed before the days are derived (spec §4). */
export const MIN_HISTORY_MONTHS = 3;
/** Months the statutory share is measured over. */
export const STATUTORY_MONTHS = 3;

export interface DeriveCompanyVat {
  registered: boolean;
  cadence: VatCadence;
  alignment: VatAlignment;
  basis: 'invoice' | 'payment';
  /** `vat_period` was NULL or blank (§13.11). */
  cadenceDefaulted: boolean;
}

export interface DeriveInputs {
  /** 'YYYY-MM-DD' the opening balances are as at. */
  asAt: string;
  /** The month before the version's first month. */
  priorYearEnd: string;
  entityType: EntityTypeCode;
  vat: DeriveCompanyVat;
  /** Opening balances, debit-positive cents (payables negative). */
  opening: { receivables: number; payables: number; inventory: number; holdsInventory: boolean };
  /** Up to 12 actual months ending on or before the as-at, oldest first. */
  trailing: readonly ActualMonth[];
  /** Output and input VAT over the history window, cents; null when not registered. */
  vatTotals: { outputTax: number; inputTax: number } | null;
  /** EMP201 PAYE (net of ETI) + UIF + SDL over the last STATUTORY_MONTHS trailing months, cents. */
  statutory: number;
  /** Active leaf liability accounts of the company (candidates for the payable accounts). */
  liabilities: readonly LiabilityAccount[];
}

export interface PayableProposal {
  account: LiabilityAccount | null;
  basis: string;
}

export interface DeriveEvidence {
  asAt: string;
  window: { first: string | null; last: string | null; months: number; days: number };
  trailing: { turnover: number; costOfSales: number; supplierPurchases: number; payroll: number; statutoryPayroll: number };
  vat: { outputTax: number; inputTax: number } | null;
  statutory: number;
  opening: { receivables: number; payables: number; inventory: number };
  insufficientHistory: boolean;
  payableAccounts: { incomeTaxPayable: PayableProposal; dividendsPayable: PayableProposal };
}

export interface DerivedAssumptions {
  assumptions: ThreeWayAssumptions;
  evidence: DeriveEvidence;
}

/** The SA standard VAT rate as a fraction (0.15). */
const VAT_STANDARD = SA_STANDARD_RATE_BP / 10_000;
const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
};
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const INCOME_TAX_ACCOUNT_NAME = /income tax|provisional tax|SARS.*tax/i;
export const DIVIDENDS_ACCOUNT_NAME = /dividend/i;

/** The one active liability account whose name matches, or none (with the reason). */
export function proposePayable(accounts: readonly LiabilityAccount[], name: RegExp, label: string): PayableProposal {
  const hits = accounts.filter((a) => name.test(a.accountName));
  if (hits.length === 1) {
    const a = hits[0] as LiabilityAccount;
    return { account: a, basis: `the only active liability account named like ${label}: ${a.accountCode} ${a.accountName}` };
  }
  return {
    account: null,
    basis: hits.length === 0
      ? `no active liability account named like ${label}; synthetic line (choose an account)`
      : `${hits.length} active liability accounts named like ${label} (${hits.map((h) => h.accountCode).join(', ')}); choose one`,
  };
}

/** The history window: trailing months from the first one with posted activity. */
export function historyWindow(trailing: readonly ActualMonth[]): ActualMonth[] {
  const first = trailing.findIndex((m) => m.active);
  return first < 0 ? [] : trailing.slice(first);
}

function share(tax: number, base: number): number | null {
  if (base <= 0) return null;
  return round(clamp(tax / (base * VAT_STANDARD), 0, 1), 4);
}

/**
 * `derivedDays` (the engine's own derive, exact cents) over the window, clamped to `max`.
 * A balance of 0 or less is 0 days; a positive balance with no positive flow has no basis (null).
 */
function days(balance: number, flows: readonly number[], win: readonly ActualMonth[], max: number): number | null {
  if (balance <= 0) return 0;
  const d = derivedDays(balance, flows, win.map((m) => daysInMonth(m.month)));
  return d === null ? null : clamp(d, 0, max);
}

export function deriveCore(x: DeriveInputs): DerivedAssumptions {
  const a = defaultAssumptions({ priorYearEnd: x.priorYearEnd, entityType: x.entityType, vat: x.vat, asAt: x.asAt });
  const derived = <T>(value: T, basis: string): Prov<T> => ({ value, source: 'derived', derivedAsAt: x.asAt, basis });
  const win = historyWindow(x.trailing);
  const sum = (f: (m: ActualMonth) => number, ms: readonly ActualMonth[] = win) => ms.reduce((s, m) => s + f(m), 0);
  const turnover = sum((m) => m.turnover);
  const costOfSales = sum((m) => m.costOfSales);
  const purchases = sum((m) => m.costOfSales + m.otherOpex);
  const windowDays = sum((m) => daysInMonth(m.month));
  const span = win.length > 0 ? `${win[0]!.month}..${win[win.length - 1]!.month}` : 'none';

  if (x.vat.cadenceDefaulted && x.vat.registered) a.vat.cadence = derived(x.vat.cadence, 'defaulted — not configured');
  const vatTotals = x.vat.registered ? x.vatTotals : null;
  if (vatTotals) {
    const sOut = share(vatTotals.outputTax, turnover);
    const sIn = share(vatTotals.inputTax, purchases);
    if (sOut !== null) a.vat.vatableSalesShare = derived(sOut, `output VAT ÷ (turnover × 15 %), ${span}`);
    if (sIn !== null) a.vat.vatablePurchasesShare = derived(sIn, `input VAT ÷ (purchases × 15 %), ${span}`);
  }

  const insufficientHistory = win.length < MIN_HISTORY_MONTHS;
  if (!insufficientHistory) {
    const sOut = toPpm(x.vat.registered ? a.vat.vatableSalesShare.value : 0);
    const sIn = toPpm(x.vat.registered ? a.vat.vatablePurchasesShare.value : 0);
    const incl = (net: number, ppm: number) => net + vatOnNet(net, ppm);
    const basis = `trailing ${win.length} months ${span}, VAT-inclusive`;
    const set = (key: 'debtorDays' | 'creditorDays' | 'inventoryDays', d: number | null, why: string) => {
      if (d !== null) a.workingCapital[key] = derived(d, why);
      else a.workingCapital[key] = derived(a.workingCapital[key].value, `no trailing flow ${span}; default`);
    };
    set('debtorDays', days(x.opening.receivables, win.map((m) => incl(m.turnover, sOut)), win, 365), basis);
    set('creditorDays', days(-x.opening.payables, win.map((m) => incl(m.costOfSales + m.otherOpex, sIn)), win, 365), basis);
    if (x.opening.holdsInventory) {
      set('inventoryDays', days(x.opening.inventory, win.map((m) => m.costOfSales), win, 730), `trailing ${win.length} months ${span}, on cost of sales`);
    } else {
      a.workingCapital.inventoryDays = derived(0, 'no inventory account held');
    }
  }

  const lastMonths = x.trailing.slice(-STATUTORY_MONTHS);
  const statutoryPayroll = sum((m) => m.payroll, lastMonths);
  a.payroll.statutoryShare = statutoryPayroll > 0
    ? derived(round(clamp(x.statutory / statutoryPayroll, 0, 1), 4), `EMP201 PAYE + UIF + SDL ÷ payroll, last ${lastMonths.length} months`)
    : derived(0, 'no payroll expense in the last 3 months');

  const tax = proposePayable(x.liabilities, INCOME_TAX_ACCOUNT_NAME, 'income tax');
  const dividends = proposePayable(x.liabilities, DIVIDENDS_ACCOUNT_NAME, 'dividends');
  if (tax.account) a.incomeTax.payableAccountId = tax.account.id;
  if (dividends.account && dividends.account.id !== tax.account?.id) a.equity.dividendsPayableAccountId = dividends.account.id;

  return {
    assumptions: a,
    evidence: {
      asAt: x.asAt,
      window: { first: win[0]?.month ?? null, last: win[win.length - 1]?.month ?? null, months: win.length, days: windowDays },
      trailing: { turnover, costOfSales, supplierPurchases: purchases, payroll: sum((m) => m.payroll), statutoryPayroll },
      vat: vatTotals,
      statutory: x.statutory,
      opening: { receivables: x.opening.receivables, payables: x.opening.payables, inventory: x.opening.inventory },
      insufficientHistory,
      payableAccounts: { incomeTaxPayable: tax, dividendsPayable: dividends },
    },
  };
}
