import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { canonicalSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { getRetainedEarningsBroughtForward } from '@/modules/accounting/services/gl/trialBalanceBasis';
import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';

type Row = DbRow;

export interface EquityColumn {
  subtype: string;
  label: string;
  opening: number;
  profitForYear: number;
  dividends: number;
  shareIssue: number;
  revaluation: number;
  /**
   * Equity movements that are none of the above — most often a year-end close
   * transferring the prior result into retained earnings, or a reclassification
   * between reserves.
   *
   * This column exists so the movement rows PARTITION the period's equity
   * postings rather than sampling them. Without it an unrecognised movement is
   * silently dropped and the closing balance stops tying to the balance sheet —
   * the same failure mode as an unmapped account vanishing from a statement.
   */
  otherMovements: number;
  closing: number;
}

export interface ChangesInEquityReport {
  periodStart: string;
  periodEnd: string;
  columns: EquityColumn[];
  totalOpening: number;
  totalProfitForYear: number;
  totalDividends: number;
  totalShareIssue: number;
  totalRevaluation: number;
  totalOtherMovements: number;
  totalClosing: number;
}

/** Column the accumulated result is reported in. */
const RETAINED_EARNINGS = 'retained_earnings';

const EQUITY_SUBTYPE_LABELS: Record<string, string> = {
  share_capital:     'Share Capital',
  share_premium:     'Share Premium',
  retained_earnings: 'Retained Earnings',
  revaluation:       'Revaluation Reserve',
};

const SUBTYPE_ORDER = ['share_capital', 'share_premium', RETAINED_EARNINGS, 'revaluation'];

function subtypeLabel(subtype: string): string {
  return EQUITY_SUBTYPE_LABELS[subtype] ?? subtype;
}

/**
 * Which movement row an equity posting belongs to, decided by the ACCOUNT it
 * was posted to.
 *
 * Never by the sign of the posting. The previous implementation read a credit
 * to retained earnings as "profit" and a debit as "dividend", so a reversed
 * dividend was reported as income the company never earned, and the gross
 * dividend was reported instead of the net distribution.
 */
type MovementRow = 'dividends' | 'shareIssue' | 'revaluation' | 'otherMovements';

function movementRowFor(rawSubtype: string): MovementRow {
  // `revaluation` is not a canonical subtype — it is a reserve name — so it is
  // matched on the raw value before canonicalisation.
  if (rawSubtype === 'revaluation') return 'revaluation';

  if (rawSubtype === 'share_capital' || rawSubtype === 'share_premium') return 'shareIssue';

  const canon = canonicalSubtype(rawSubtype);
  if (canon === 'equity') return 'shareIssue';

  // Movements ON retained earnings during the period are distributions to
  // owners. Profit is NOT one of them: it comes from the income statement.
  if (canon === 'retained_earnings' || rawSubtype === RETAINED_EARNINGS) return 'dividends';

  return 'otherMovements';
}

async function fetchOpeningBalances(companyId: string, beforeDate: string): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT
      COALESCE(ga.account_subtype, ${RETAINED_EARNINGS}) AS account_subtype,
      COALESCE(SUM(jl.credit - jl.debit), 0)::numeric  AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status     = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND ga.account_type = 'equity'
      AND je.entry_date < ${beforeDate}
    GROUP BY 1
  `) as Row[];

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(String(r.account_subtype), Number(r.balance));
  }
  return map;
}

/**
 * Equity postings inside the period, by account subtype.
 *
 * One signed net amount per subtype — deliberately NOT split by the sign of
 * individual lines, which is what manufactured the phantom profit column.
 */
async function fetchMovements(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Array<{ subtype: string; amount: number }>> {
  const rows = (await sql`
    SELECT
      COALESCE(ga.account_subtype, ${RETAINED_EARNINGS}) AS account_subtype,
      COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status     = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND ga.account_type = 'equity'
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
    GROUP BY 1
  `) as Row[];

  return rows.map(r => ({
    subtype: String(r.account_subtype),
    amount:  Number(r.amount),
  }));
}

function emptyColumn(subtype: string): EquityColumn {
  return {
    subtype,
    label:          subtypeLabel(subtype),
    opening:        0,
    profitForYear:  0,
    dividends:      0,
    shareIssue:     0,
    revaluation:    0,
    otherMovements: 0,
    closing:        0,
  };
}

export async function getChangesInEquity(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ChangesInEquityReport> {
  try {
    const [openingMap, movements, broughtForward, figures] = await Promise.all([
      fetchOpeningBalances(companyId, periodStart),
      fetchMovements(companyId, periodStart, periodEnd),
      // Accumulated result earned before the period. No production company
      // carries a posted retained-earnings balance, so without this the
      // opening column omits every prior year the business traded.
      getRetainedEarningsBroughtForward(companyId, periodStart),
      // Profit for the year is the income statement, full stop.
      getFinancialFigures(companyId, periodStart, periodEnd),
    ]);

    const columnMap = new Map<string, EquityColumn>();
    const columnFor = (subtype: string): EquityColumn => {
      let col = columnMap.get(subtype);
      if (!col) {
        col = emptyColumn(subtype);
        columnMap.set(subtype, col);
      }
      return col;
    };

    for (const [subtype, opening] of openingMap) {
      columnFor(subtype).opening = opening;
    }

    // The accumulated result and this period's profit are both reported in the
    // retained earnings column, which is created if the company has never
    // posted to it.
    columnFor(RETAINED_EARNINGS).opening += broughtForward;
    columnFor(RETAINED_EARNINGS).profitForYear += figures.period.netProfit;

    for (const mv of movements) {
      columnFor(mv.subtype)[movementRowFor(mv.subtype)] += mv.amount;
    }

    for (const col of columnMap.values()) {
      col.closing =
        col.opening +
        col.profitForYear +
        col.dividends +
        col.shareIssue +
        col.revaluation +
        col.otherMovements;
    }

    const columns = [...columnMap.values()].sort((a, b) => {
      const ai = SUBTYPE_ORDER.indexOf(a.subtype);
      const bi = SUBTYPE_ORDER.indexOf(b.subtype);
      if (ai === -1 && bi === -1) return a.subtype.localeCompare(b.subtype);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    const sum = (key: keyof EquityColumn) =>
      columns.reduce((s, c) => s + (c[key] as number), 0);

    return {
      periodStart,
      periodEnd,
      columns,
      totalOpening:        sum('opening'),
      totalProfitForYear:  sum('profitForYear'),
      totalDividends:      sum('dividends'),
      totalShareIssue:     sum('shareIssue'),
      totalRevaluation:    sum('revaluation'),
      totalOtherMovements: sum('otherMovements'),
      totalClosing:        sum('closing'),
    };
  } catch (err) {
    log.error('Failed to generate changes in equity', { error: err }, 'accounting');
    throw err;
  }
}
