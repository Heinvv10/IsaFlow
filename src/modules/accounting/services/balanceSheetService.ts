/**
 * Balance Sheet Service
 * Generates balance sheet reports from the general ledger.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from './systemAccountResolver';
import type { BalanceSheetReport } from '../types/gl.types';

type Row = Record<string, unknown>;

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
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND je.entry_date <= ${asAtDate}
      AND ga.account_type IN ('revenue', 'expense')
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
  `) as Row[];

  return Number(rows[0]!.revenue) - Number(rows[0]!.expenses);
}

async function fetchBalanceSheetData(companyId: string, asAtDate: string, costCentreId?: string) {
  const ccId = costCentreId ?? null;

  const rows = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
      COALESCE(SUM(jl.debit), 0) AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND je.entry_date <= ${asAtDate}
      AND ga.account_type IN ('asset', 'liability', 'equity')
      AND ga.level >= 3
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

    const item: BSLineItem = { accountCode: String(r.account_code), accountName: String(r.account_name), balance };
    if (type === 'asset') assets.push(item);
    else if (type === 'liability') liabilities.push(item);
    else if (type === 'equity') equity.push(item);
  }

  const retainedEarnings = await calculateRetainedEarnings(companyId, asAtDate, costCentreId);
  if (Math.abs(retainedEarnings) > 0.01) {
    const reAccount = await getSystemAccount('retained_earnings');
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

    const report: BalanceSheetReport = {
      asAtDate,
      costCentreId,
      assets: current.assets,
      liabilities: current.liabilities,
      equity: current.equity,
      totalAssets: current.assets.reduce((s, a) => s + a.balance, 0),
      totalLiabilities: current.liabilities.reduce((s, l) => s + l.balance, 0),
      totalEquity: current.equity.reduce((s, e) => s + e.balance, 0),
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
