/**
 * Pure folds from database rows to engine input (P6 spec §5 Input, §13 items
 * 6 and 8). The DB readers gather rows; everything decided about them is here,
 * so it is unit-tested without a database.
 *
 * - `foldPnl`: the version's stored budget rows (`readTrackingBudgets`, every
 *   grain) → one company-level `PnlMonth` per version month, by `pnlBandOf`.
 *   Stored amounts are never roll-ups (a legacy header's own amounts count once,
 *   decision 18), so summing every row of an account is the grid's counting rule.
 * - `foldActuals`: posted P&L actuals (`readTrackingActuals`) → per-month band
 *   sums over a fixed month list (absent months are 0).
 * - `toLookback`: those months as the engine's lookback. Supplier purchases =
 *   cost of sales + other opex: the actuals read covers the P&L only, so stock
 *   movement in the lookback is taken as nil (documented limitation).
 * - `foldOpening`: per-account balance-sheet balances → debit-positive buckets,
 *   the unmapped list and the per-type totals `getBalanceSheet` reports.
 */
import { MAX_MONEY } from '@/lib/money/wholeCents';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { EngineInputError } from './errors';
import { checkedAdd } from './ratios';
import { bucketOf, pnlBandOf, type BalanceSheetType } from './bucketMap';
import { addMonths, daysInMonth } from './months';
import { emptyBuckets, emptyPnl, type BucketKey, type Buckets, type LookbackMonth, type PnlMonth, type UnmappedBalance, type UnmappedBucket } from './types';

export interface PnlRow {
  accountType: 'revenue' | 'expense';
  accountSubtype: string | null;
  /** 'YYYY-MM'. */
  month: string;
  /** Rand, natural sign (revenue and expense positive). */
  amount: number;
}

/** Rand → cents; beyond NUMERIC(15,2) is the engine's typed RANGE refusal (a 4xx), never a bare RangeError. */
function rowCents(rand: number, month: string): number {
  if (!Number.isFinite(rand) || Math.abs(rand) > MAX_MONEY) throw new EngineInputError('RANGE', `A ${month} figure is beyond the budget range: ${rand}`);
  return toCents(rand);
}

function foldRows(rows: readonly PnlRow[], months: readonly string[]): PnlMonth[] {
  const index = new Map(months.map((m, i) => [m, i]));
  const out = months.map(() => emptyPnl());
  for (const r of rows) {
    const i = index.get(r.month);
    if (i === undefined) continue;
    const band = pnlBandOf(r.accountType, r.accountSubtype);
    const month = out[i] as PnlMonth;
    month[band] = checkedAdd(month[band], rowCents(r.amount, r.month));
  }
  return out;
}

/** The version's budget per month by engine band, cents; rows outside `months` are ignored. */
export function foldPnl(rows: readonly PnlRow[], months: readonly string[]): PnlMonth[] {
  return foldRows(rows, months);
}

export interface ActualMonth extends PnlMonth {
  month: string;
  /** True when any posted P&L movement fell in the month. */
  active: boolean;
}

/** Posted actuals per month by engine band, cents, over exactly `months`. */
export function foldActuals(rows: readonly PnlRow[], months: readonly string[]): ActualMonth[] {
  const sums = foldRows(rows, months);
  const active = new Set(rows.filter((r) => r.amount !== 0).map((r) => r.month));
  return months.map((m, i) => ({ ...(sums[i] as PnlMonth), month: m, active: active.has(m) }));
}

/** Actual months as the engine's lookback (ex VAT, cents). */
export function toLookback(actuals: readonly ActualMonth[]): LookbackMonth[] {
  return actuals.map((a) => ({
    month: a.month,
    turnover: a.turnover,
    costOfSales: a.costOfSales,
    supplierPurchases: a.costOfSales + a.otherOpex,
  }));
}

export interface OpeningAccountRow {
  accountId: string;
  accountCode: string;
  accountType: BalanceSheetType;
  accountSubtype: string | null;
  /** Posted debit less credit to the as-at date, cents. */
  netDebit: number;
}

export interface OpeningTotals {
  /** Natural sign, cents: what `getBalanceSheet` reports as totalAssets / totalLiabilities / totalEquity. */
  assets: number;
  liabilities: number;
  equity: number;
}

export interface FoldedAccount {
  accountCode: string;
  bucket: BucketKey;
  mapped: boolean;
  /** Debit-positive cents. */
  balance: number;
}

export interface FoldedOpening {
  buckets: Buckets;
  unmapped: UnmappedBalance[];
  totals: OpeningTotals;
  /** Cash-bucket balance per account id (for the `getCashBalance` parity check). */
  cashAccounts: Map<string, { accountCode: string; balance: number }>;
  /** Every leaf account with a posted balance, by id: where it was bucketed. */
  accounts: Map<string, FoldedAccount>;
}

/**
 * Buckets from per-account balances plus derived retained earnings (revenue
 * less expenses to the date, credit-positive), which joins `retainedEarnings`
 * as `getBalanceSheet` adds it to the system RE line.
 */
export function foldOpening(
  rows: readonly OpeningAccountRow[],
  derivedRetainedEarnings: number,
  loanAccountIds: ReadonlySet<string>,
  retainedEarningsAccountId: string | null,
): FoldedOpening {
  const buckets = emptyBuckets();
  const unmapped: UnmappedBalance[] = [];
  const totals: OpeningTotals = { assets: 0, liabilities: 0, equity: derivedRetainedEarnings };
  const cashAccounts = new Map<string, { accountCode: string; balance: number }>();
  const accounts = new Map<string, FoldedAccount>();
  for (const r of rows) {
    const choice = bucketOf(r.accountType, r.accountSubtype, {
      isLoanAccount: loanAccountIds.has(r.accountId),
      isRetainedEarningsAccount: r.accountId === retainedEarningsAccountId,
    });
    buckets[choice.bucket] += r.netDebit;
    if (!choice.mapped) unmapped.push({ accountCode: r.accountCode, bucket: choice.bucket as UnmappedBucket, balance: r.netDebit });
    if (choice.bucket === 'cash') cashAccounts.set(r.accountId, { accountCode: r.accountCode, balance: r.netDebit });
    accounts.set(r.accountId, { accountCode: r.accountCode, bucket: choice.bucket, mapped: choice.mapped, balance: r.netDebit });
    if (r.accountType === 'asset') totals.assets += r.netDebit;
    else if (r.accountType === 'liability') totals.liabilities -= r.netDebit;
    else totals.equity -= r.netDebit;
  }
  buckets.retainedEarnings -= derivedRetainedEarnings;
  // -0 (a credit of 0 subtracted) reads as 0 on the wire.
  for (const k of Object.keys(buckets) as Array<keyof Buckets>) if (buckets[k] === 0) buckets[k] = 0;
  return { buckets, unmapped, totals, cashAccounts, accounts };
}

/** The accounts the assumptions name for the payables that have no subtype (spec §5, §13.10). */
export interface PayableAccounts {
  incomeTaxPayable?: string;
  dividendsPayable?: string;
}

/**
 * The opening with each named account's balance moved from the bucket it was folded into (usually
 * `otherCurrentLiabilities`) into `incomeTaxPayable` / `dividendsPayable`; an account that was unmapped
 * leaves the unmapped list. An account with no posted balance moves nothing. Pure; never mutates `o`.
 */
export function applyPayableAccounts(
  o: Pick<FoldedOpening, 'buckets' | 'unmapped' | 'accounts'>, named: PayableAccounts,
): { buckets: Buckets; unmapped: UnmappedBalance[] } {
  const buckets = { ...o.buckets };
  let unmapped = [...o.unmapped];
  for (const [target, id] of [['incomeTaxPayable', named.incomeTaxPayable], ['dividendsPayable', named.dividendsPayable]] as const) {
    const acc = id ? o.accounts.get(id.toLowerCase()) : undefined;
    if (!acc || acc.bucket === target) continue;
    buckets[acc.bucket] -= acc.balance;
    buckets[target] += acc.balance;
    if (buckets[acc.bucket] === 0) buckets[acc.bucket] = 0;
    if (!acc.mapped) unmapped = unmapped.filter((u) => u.accountCode !== acc.accountCode);
  }
  return { buckets, unmapped };
}

/** 'YYYY-MM-DD' of the month's last day. */
export function monthLastDay(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}

/**
 * Decision 10a: the opening is as at the day before the first month; when that
 * day is after `today`, it is today's (the latest actual date) and provisional.
 */
export function openingAsAt(firstMonth: string, today: string): { asAt: string; provisional: boolean } {
  const dayBefore = monthLastDay(addMonths(firstMonth, -1));
  return dayBefore > today ? { asAt: today, provisional: true } : { asAt: dayBefore, provisional: false };
}

/** The `count` months ending with the last WHOLE month on or before `asAt` (oldest first). */
export function trailingMonthsTo(asAt: string, count: number): string[] {
  const month = asAt.slice(0, 7);
  const last = asAt === monthLastDay(month) ? month : addMonths(month, -1);
  return Array.from({ length: count }, (_, i) => addMonths(last, i - count + 1));
}

/** The `count` months before `firstMonth` (oldest first): the engine's lookback. */
export function lookbackMonthsBefore(firstMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(firstMonth, i - count));
}
