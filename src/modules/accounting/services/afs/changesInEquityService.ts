import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { canonicalSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { getRetainedEarningsBroughtForward } from '@/modules/accounting/services/gl/trialBalanceBasis';
import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { TAKE_ON_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/takeOnJournalSource';
import { DIVIDENDS_PAID_CODE } from './noteGenerators/primaryStatements/dividendsPaid';

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
   * Equity movements on a reserve none of the other rows recognise — a foreign
   * currency translation reserve, say, or any subtype `canonicalSubtype` does
   * not know.
   *
   * This column exists so the movement rows PARTITION the period's equity
   * postings rather than sampling them. Without it an unrecognised movement is
   * silently dropped and the closing balance stops tying to the balance sheet —
   * the same failure mode as an unmapped account vanishing from a statement.
   *
   * NOT a year-end close. The close journal (source = 'year_end', admitted by
   * migration 627) never reaches this statement: both queries below skip it
   * (YEAR_END_JOURNAL_SOURCE), because the profit it transfers into retained
   * earnings is already the derived profit-for-the-year and opening column.
   * Reading it too booked the profit under `dividends` (a credit to retained
   * earnings that is not profit) and left profit-for-the-year at 0 (G-01).
   */
  otherMovements: number;
  /**
   * Balances brought into IsaFlow during the period by a take-on journal
   * (gl/takeOnJournalSource: wizard / file migration / Import from Sage opening
   * balances and take-on documents, MCP set_opening_balance, and reversals of
   * them, which copy the source and so net here). A take-on onto an IS484
   * dividends account lands here too, in the retained-earnings column: it is a
   * balance carried in, and the AFS SOCE leaves it out of dividends paid the
   * same way. Without this row a take-on onto Retained Earnings read as a
   * DIVIDEND, and one onto share capital or another equity account as a share issue.
   */
  takeOn: number;
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
  totalTakeOn: number;
  totalClosing: number;
}

/** Column the accumulated result is reported in. */
const RETAINED_EARNINGS = 'retained_earnings';

const EQUITY_SUBTYPE_LABELS: Record<string, string> = {
  share_capital:     'Share Capital',
  share_premium:     'Share Premium',
  retained_earnings: 'Retained Earnings',
  revaluation:       'Revaluation Reserve',
  opening_balance_equity: 'Opening Balance Equity',
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
      -- A dividends account on IS484 "Dividends paid" (dividendsPaid.ts) is a distribution out of retained
      -- earnings, so its balance is reported in that column whatever its subtype.
      CASE WHEN (ga.normal_balance = 'debit' OR ga.account_subtype = 'dividends') AND EXISTS (
        SELECT 1 FROM afs_account_mappings am
        WHERE am.company_id = ${companyId}::UUID AND am.gl_account_id = ga.id
          AND am.afs_line_code = ${DIVIDENDS_PAID_CODE}) THEN ${RETAINED_EARNINGS}
        ELSE COALESCE(ga.account_subtype, ${RETAINED_EARNINGS}) END AS account_subtype,
      COALESCE(SUM(jl.credit - jl.debit), 0)::numeric  AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status     = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
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
): Promise<Array<{ subtype: string; amount: number; isDividends: boolean; isTakeOn: boolean }>> {
  const rows = (await sql`
    SELECT
      COALESCE(ga.account_subtype, ${RETAINED_EARNINGS}) AS account_subtype,
      -- A dividends account on IS484 "Dividends paid": its movements are dividends (see fetchOpeningBalances).
      (ga.normal_balance = 'debit' OR ga.account_subtype = 'dividends') AND EXISTS (
        SELECT 1 FROM afs_account_mappings am
        WHERE am.company_id = ${companyId}::UUID AND am.gl_account_id = ga.id
          AND am.afs_line_code = ${DIVIDENDS_PAID_CODE}) AS is_dividends,
      je.source = ${TAKE_ON_JOURNAL_SOURCE} AS is_take_on,
      COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status     = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND ga.account_type = 'equity'
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
    GROUP BY 1, 2, 3
  `) as Row[];

  return rows.map(r => ({
    subtype:     String(r.account_subtype),
    amount:      Number(r.amount),
    isDividends: r.is_dividends === true,
    isTakeOn:    r.is_take_on === true,
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
    takeOn:         0,
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
      // A take-on first, whatever account it lands on: a balance carried in
      // (Hein, 2026-10-21), dividends included — an IS484 dividends account's in
      // the retained-earnings column, as its opening is. The AFS SOCE leaves the
      // same postings out of dividends paid (gl/takeOnJournalSource).
      if (mv.isTakeOn) columnFor(mv.isDividends ? RETAINED_EARNINGS : mv.subtype).takeOn += mv.amount;
      else if (mv.isDividends) columnFor(RETAINED_EARNINGS).dividends += mv.amount;
      else columnFor(mv.subtype)[movementRowFor(mv.subtype)] += mv.amount;
    }

    for (const col of columnMap.values()) {
      col.closing =
        col.opening +
        col.profitForYear +
        col.dividends +
        col.shareIssue +
        col.revaluation +
        col.otherMovements +
        col.takeOn;
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
      totalTakeOn:         sum('takeOn'),
      totalClosing:        sum('closing'),
    };
  } catch (err) {
    log.error('Failed to generate changes in equity', { error: err }, 'accounting');
    throw err;
  }
}
