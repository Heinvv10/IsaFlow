/**
 * Single source of P&L and balance-sheet figures for every report endpoint.
 *
 * One grouped query over posted GL movement, folded by
 * `@/modules/accounting/services/gl/accountClassification` — which classifies
 * on `account_type` and a canonicalised `account_subtype`, never on
 * `account_code`. The report endpoints that used to hand-roll
 * `CASE WHEN account_code LIKE '1%'` all call this instead.
 */

import { sql } from '@/lib/neon';
import {
  INVENTORY_SUBTYPES,
  aggregateFigures,
  type AccountType,
  type ClassificationRow,
  type ClassifiedFigures,
} from './accountClassification';
import { getRetainedEarningsBroughtForward } from './trialBalanceBasis';
import type { FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';

interface RawRow {
  account_type: AccountType;
  account_subtype: string | null;
  account_count: string | number;
  period_debit: string | number;
  period_credit: string | number;
  cumulative_debit: string | number;
  cumulative_credit: string | number;
}

export interface PeriodFigures {
  /**
   * Whether this company classifies inventory at all — i.e. any GL account
   * carries an inventory subtype, posted to or not. When false, `inventory` is
   * zero because nothing could be identified, NOT because there is none, and
   * any quick ratio derived from these figures has not actually excluded
   * inventory. See `inventoryWarning`.
   */
  inventoryClassified: boolean;
  /**
   * Accumulated profit (credit-positive) earned strictly BEFORE `from`.
   *
   * `cumulative` is since-inception but holds no revenue or expense, so equity
   * has to carry the accumulated result or the balance sheet does not balance.
   * Adding back only `period.netProfit` drops everything earned earlier —
   * R28,356,760.75 of accumulated loss on Velocity Fibre alone.
   *
   * Computed by trialBalanceBasis, which owns this quantity and which the
   * trial balance already depends on being right. Not reimplemented here.
   */
  retainedEarningsBroughtForward: number;
  /** Movement inside [from, to] — the P&L. */
  period: ClassifiedFigures;
  /** Movement up to and including `to` — the balance sheet. */
  cumulative: ClassifiedFigures;
}

/**
 * @param companyId tenant scope — applied to both journal tables.
 * @param from inclusive period start (YYYY-MM-DD) for the P&L figures.
 * @param to inclusive period end (YYYY-MM-DD); also the balance-sheet date.
 */
export async function getFinancialFigures(
  companyId: string,
  from: string,
  to: string
): Promise<PeriodFigures> {
  const [rows, inventoryProbe, broughtForward] = await Promise.all([
    sql`
    SELECT
      ga.account_type,
      ga.account_subtype,
      COUNT(DISTINCT ga.id) AS account_count,
      COALESCE(SUM(CASE WHEN je.entry_date >= ${from}::date THEN jl.debit ELSE 0 END), 0) AS period_debit,
      COALESCE(SUM(CASE WHEN je.entry_date >= ${from}::date THEN jl.credit ELSE 0 END), 0) AS period_credit,
      COALESCE(SUM(jl.debit), 0) AS cumulative_debit,
      COALESCE(SUM(jl.credit), 0) AS cumulative_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${to}::date
    GROUP BY ga.account_type, ga.account_subtype
  ` as unknown as Promise<RawRow[]>,
    // Deliberately over the chart of accounts, not the journal: an inventory
    // account that exists but has never been posted to is still "classified",
    // and warning about it forever would be noise.
    sql`
      SELECT EXISTS (
        SELECT 1 FROM gl_accounts
        WHERE company_id = ${companyId}::UUID
          AND account_type = 'asset'
          AND account_subtype = ANY(${INVENTORY_SUBTYPES as string[]}::TEXT[])
      ) AS has_inventory
    ` as unknown as Promise<Array<{ has_inventory: boolean }>>,
    getRetainedEarningsBroughtForward(companyId, from),
  ]);

  const asPeriod: ClassificationRow[] = rows.map((r) => ({
    account_type: r.account_type,
    account_subtype: r.account_subtype,
    debit: r.period_debit,
    credit: r.period_credit,
    account_count: r.account_count,
  }));
  const asCumulative: ClassificationRow[] = rows.map((r) => ({
    account_type: r.account_type,
    account_subtype: r.account_subtype,
    debit: r.cumulative_debit,
    credit: r.cumulative_credit,
    account_count: r.account_count,
  }));

  return {
    inventoryClassified: inventoryProbe[0]?.has_inventory === true,
    retainedEarningsBroughtForward: broughtForward,
    period: aggregateFigures(asPeriod),
    cumulative: aggregateFigures(asCumulative),
  };
}

/**
 * Total equity: posted equity, plus this period's result, plus everything
 * accumulated before `from`.
 *
 * The one definition. Seven endpoints used to inline
 * `cumulative.totalEquity + period.netProfit`, which silently dropped the
 * pre-period result and left the balance sheet out by R28,356,760.75 on
 * Velocity Fibre alone. Call this rather than re-deriving it.
 */
export function totalEquity(figures: PeriodFigures): number {
  return (
    figures.cumulative.totalEquity +
    figures.period.netProfit +
    figures.retainedEarningsBroughtForward
  );
}

/**
 * Map the resolver output onto the `FinancialData` shape the reporting engine
 * and report packs consume.
 *
 * Equity carries the accumulated result — this period's plus everything before
 * `from` — because profit is not closed into retained earnings until year end
 * and `cumulative` excludes revenue and expense entirely. The previous
 * per-endpoint SQL added back only the current period and so reported a balance
 * sheet that did not balance; centralising the defect here is what let one fix
 * settle it for all ten endpoints.
 */
export function toFinancialData(figures: PeriodFigures): FinancialData {
  const { period, cumulative } = figures;
  return {
    revenue: period.revenue,
    costOfSales: period.costOfSales,
    operatingExpenses: period.operatingExpenses,
    // Carried, not re-derived downstream: see FinancialData.operatingProfit.
    operatingProfit: period.operatingProfit,
    otherIncome: period.otherIncome,
    netProfit: period.netProfit,
    totalAssets: cumulative.totalAssets,
    totalLiabilities: cumulative.totalLiabilities,
    totalEquity: totalEquity(figures),
    currentAssets: cumulative.currentAssets,
    currentLiabilities: cumulative.currentLiabilities,
    inventory: cumulative.inventory,
    accountsReceivable: cumulative.accountsReceivable,
    accountsPayable: cumulative.accountsPayable,
    cash: cumulative.cash,
    depreciation: period.depreciation,
  };
}

/**
 * Warning payload for reports that present these figures. Non-null whenever the
 * chart of accounts left subtypes NULL or unrecognised and the resolver had to
 * default them to current — see the audit note in accountSubtypes.ts.
 */
export function unclassifiedWarning(
  figures: ClassifiedFigures
): {
  accounts: number;
  amount: number;
  message: string;
  byType: Array<{ type: AccountType; accounts: number; amount: number; defaultedTo: string }>;
} | null {
  if (figures.unclassifiedCount === 0) return null;
  const byType = (Object.keys(DEFAULT_DESTINATION) as AccountType[])
    .map((type) => ({
      type,
      accounts: figures.unclassifiedByType[type].accounts,
      amount: figures.unclassifiedByType[type].amount,
      defaultedTo: DEFAULT_DESTINATION[type],
    }))
    .filter((t) => t.accounts > 0);
  return {
    accounts: figures.unclassifiedCount,
    amount: figures.unclassifiedTotal,
    message:
      `${figures.unclassifiedCount} account(s) have no recognised subtype, so a default ` +
      `was applied. Set account_subtype on them for accurate figures.`,
    byType,
  };
}

/** What an unknown subtype of each type is silently treated as. */
const DEFAULT_DESTINATION: Record<AccountType, string> = {
  asset: 'current assets',
  liability: 'current liabilities',
  equity: '',
  revenue: 'revenue rather than other income',
  expense: 'operating expenses rather than cost of sales',
};

/**
 * Warning payload for any report publishing a quick (acid-test) ratio.
 *
 * Non-null when the company classifies no account as inventory, in which case
 * `inventory` is 0.00 for want of a signal and the quick ratio is arithmetically
 * identical to the current ratio. Reporting the two as equal without saying so
 * is the silent-wrongness this audit exists to remove: it looks exactly like a
 * company that genuinely holds no stock.
 */
export function inventoryWarning(
  figures: PeriodFigures
): { resolved: false; message: string } | null {
  if (figures.inventoryClassified) return null;
  return {
    resolved: false,
    message:
      'No GL account is classified as inventory, so inventory could not be ' +
      'identified and the quick ratio does not exclude it — it equals the ' +
      'current ratio. Set account_subtype to \'inventory\' on the stock ' +
      'control account for a meaningful acid-test ratio.',
  };
}
