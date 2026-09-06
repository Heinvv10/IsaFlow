/**
 * Balance Sheet Service
 * Generates balance sheet reports from the general ledger.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from '../gl/systemAccountResolver';
import type { BalanceSheetReport } from '../../types/gl.types';

type Row = DbRow;

interface BSLineItem {
  accountCode: string;
  accountName: string;
  balance: number;
}

async function calculateRetainedEarnings(companyId: string, asAtDate: string, costCentreId?: string): Promise<number> {
  const ccId = costCentreId ?? null;
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date <= ${asAtDate}
      AND ga.account_type IN ('revenue', 'expense')
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
  `) as Row[];

  return Number(rows[0]!.revenue) - Number(rows[0]!.expenses);
}

/**
 * The TWO equity figures, kept apart.
 *
 * `getBalanceSheet`'s `totalEquity` is not an independent opinion about equity:
 * `fetchBalanceSheetData` computes retained earnings as revenue less expenses
 * to the date and INJECTS it into the equity section. By double entry,
 * assets − liabilities − posted equity IS revenue less expenses, so
 * `totalEquity` equals assets − liabilities by construction and agreeing with
 * the residual tells a reader nothing.
 *
 * It looked like it told them something. On all three production companies the
 * two agreed to the cent. Querying the equity ACCOUNTS says otherwise:
 * Brightsphere and Velocity Fibre each carry R0.00 of posted equity, so every
 * cent of Brightsphere's R8,394,848.60 and of Velocity's −R34,816,224.89 is a
 * derived plug — profit that no year-end close has ever posted to an equity
 * account.
 *
 * The identity a caller can check:
 *   assets − liabilities = posted + derivedRetainedEarnings
 */
export interface EquityBases {
  /** Sum of POSTED equity-account balances. No derived retained earnings. */
  posted: number;
  /** Revenue less expenses to the date — the figure the balance sheet injects. */
  derivedRetainedEarnings: number;
}

/**
 * @param asAtDate 'YYYY-MM-DD'. A string throughout, as everywhere on this path.
 */
export async function getEquityBases(
  companyId: string,
  asAtDate: string,
  costCentreId?: string,
): Promise<EquityBases> {
  const ccId = costCentreId ?? null;
  try {
    const rows = (await sql`
      SELECT COALESCE(SUM(CASE WHEN ga.account_type = 'equity'
                               THEN jl.credit - jl.debit ELSE 0 END), 0) AS posted
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date <= ${asAtDate}
        AND ga.account_type = 'equity'
        AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
    `) as Row[];

    return {
      posted: Number(rows[0]?.posted ?? 0),
      // The same function the balance sheet injects from, so the two cannot
      // drift into two answers about one figure.
      derivedRetainedEarnings: await calculateRetainedEarnings(companyId, asAtDate, costCentreId),
    };
  } catch (err) {
    log.error('Failed to read the equity bases', { error: err }, 'accounting');
    throw err;
  }
}

async function fetchBalanceSheetData(companyId: string, asAtDate: string, costCentreId?: string) {
  const ccId = costCentreId ?? null;

  // Include leaf accounts at any level (level >= 3 for standard CoA hierarchy,
  // plus level = 1 accounts that have no children, as used by Sage-imported accounts).
  const rows = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
      COALESCE(SUM(jl.debit), 0) AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date <= ${asAtDate}
      AND ga.account_type IN ('asset', 'liability', 'equity')
      AND (
        ga.level >= 3
        OR NOT EXISTS (
          SELECT 1 FROM gl_accounts child
          WHERE child.parent_account_id = ga.id
            AND child.company_id = ${companyId}::UUID
        )
      )
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance
    ORDER BY ga.account_code
  `) as Row[];

  const assets: BSLineItem[] = [];
  const liabilities: BSLineItem[] = [];
  const equity: BSLineItem[] = [];

  for (const r of rows) {
    const type = String(r.account_type);
    const normalBal = String(r.normal_balance);
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    const balance = normalBal === 'debit' ? debit - credit : credit - debit;
    if (Math.abs(balance) < 0.01) continue;

    // Contra-assets (asset type, credit normal balance e.g. Accumulated Depreciation) must
    // reduce total assets. Negate the balance so they subtract from totalAssets correctly.
    const reportBalance = (type === 'asset' && normalBal === 'credit') ? -balance : balance;
    const item: BSLineItem = { accountCode: String(r.account_code), accountName: String(r.account_name), balance: reportBalance };
    if (type === 'asset') assets.push(item);
    else if (type === 'liability') liabilities.push(item);
    else if (type === 'equity') equity.push(item);
  }

  const retainedEarnings = await calculateRetainedEarnings(companyId, asAtDate, costCentreId);
  if (Math.abs(retainedEarnings) > 0.01) {
    const reAccount = await getSystemAccount('retained_earnings', companyId);
    const existing = equity.find(e => e.accountCode === reAccount.accountCode);
    if (existing) existing.balance += retainedEarnings;
    else equity.push({ accountCode: reAccount.accountCode, accountName: 'Retained Earnings (Current)', balance: retainedEarnings });
  }

  return { assets, liabilities, equity };
}

export async function getBalanceSheet(companyId: string,
  asAtDate: string,
  costCentreId?: string,
  compareDate?: string
): Promise<BalanceSheetReport> {
  try {
    const [current, prior] = await Promise.all([
      fetchBalanceSheetData(companyId, asAtDate, costCentreId),
      compareDate
        ? fetchBalanceSheetData(companyId, compareDate, costCentreId)
        : Promise.resolve(null),
    ]);

    const totalAssets = current.assets.reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = current.liabilities.reduce((s, l) => s + l.balance, 0);
    const totalEquity = current.equity.reduce((s, e) => s + e.balance, 0);

    const imbalance = Math.abs(totalAssets - (totalLiabilities + totalEquity));
    if (imbalance > 0.01) {
      log.warn(
        'Balance sheet equation violated: Assets ≠ Liabilities + Equity',
        { asAtDate, totalAssets, totalLiabilities, totalEquity, imbalance },
        'accounting',
      );
    }

    const report: BalanceSheetReport = {
      asAtDate,
      costCentreId,
      assets: current.assets,
      liabilities: current.liabilities,
      equity: current.equity,
      totalAssets,
      totalLiabilities,
      totalEquity,
    };

    if (compareDate && prior) {
      report.compareDate = compareDate;
      report.priorTotalAssets = prior.assets.reduce((s, a) => s + a.balance, 0);
      report.priorTotalLiabilities = prior.liabilities.reduce((s, l) => s + l.balance, 0);
      report.priorTotalEquity = prior.equity.reduce((s, e) => s + e.balance, 0);

      const mergeBSLines = (curr: BSLineItem[], prev: BSLineItem[]) => {
        const priorMap = new Map(prev.map(p => [p.accountCode, p.balance]));
        return curr.map(c => {
          const pb = priorMap.get(c.accountCode) ?? 0;
          const variance = c.balance - pb;
          return { ...c, priorBalance: pb, variance, variancePct: pb !== 0 ? (variance / Math.abs(pb)) * 100 : 0 };
        });
      };
      report.assets = mergeBSLines(current.assets, prior.assets);
      report.liabilities = mergeBSLines(current.liabilities, prior.liabilities);
      report.equity = mergeBSLines(current.equity, prior.equity);
    }

    return report;
  } catch (err) {
    log.error('Failed to generate balance sheet', { error: err }, 'accounting');
    throw err;
  }
}
