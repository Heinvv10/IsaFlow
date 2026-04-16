import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface EquityColumn {
  subtype: string;
  label: string;
  opening: number;
  profitForYear: number;
  dividends: number;
  shareIssue: number;
  revaluation: number;
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
  totalClosing: number;
}

const EQUITY_SUBTYPE_LABELS: Record<string, string> = {
  share_capital:     'Share Capital',
  share_premium:     'Share Premium',
  retained_earnings: 'Retained Earnings',
  revaluation:       'Revaluation Reserve',
};

const SUBTYPE_ORDER = ['share_capital', 'share_premium', 'retained_earnings', 'revaluation'];

function subtypeLabel(subtype: string): string {
  return EQUITY_SUBTYPE_LABELS[subtype] ?? subtype;
}

async function fetchOpeningBalances(companyId: string, beforeDate: string): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT
      COALESCE(ga.account_subtype, 'retained_earnings') AS account_subtype,
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
    GROUP BY COALESCE(ga.account_subtype, 'retained_earnings')
  `) as Row[];

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(String(r.account_subtype), Number(r.balance));
  }
  return map;
}

async function fetchMovements(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Array<{ subtype: string; movementType: string; amount: number }>> {
  const rows = (await sql`
    SELECT
      COALESCE(ga.account_subtype, 'retained_earnings') AS account_subtype,
      CASE
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) > 0  THEN 'profit'
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) <= 0 THEN 'dividend'
        WHEN ga.account_subtype IN ('share_capital', 'share_premium') THEN 'share_issue'
        WHEN ga.account_subtype = 'revaluation'                       THEN 'revaluation'
        ELSE 'other'
      END AS movement_type,
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
    GROUP BY
      COALESCE(ga.account_subtype, 'retained_earnings'),
      CASE
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) > 0  THEN 'profit'
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) <= 0 THEN 'dividend'
        WHEN ga.account_subtype IN ('share_capital', 'share_premium') THEN 'share_issue'
        WHEN ga.account_subtype = 'revaluation'                       THEN 'revaluation'
        ELSE 'other'
      END
  `) as Row[];

  return rows.map(r => ({
    subtype:      String(r.account_subtype),
    movementType: String(r.movement_type),
    amount:       Number(r.amount),
  }));
}

export async function getChangesInEquity(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ChangesInEquityReport> {
  try {
    const [openingMap, movements] = await Promise.all([
      fetchOpeningBalances(companyId, periodStart),
      fetchMovements(companyId, periodStart, periodEnd),
    ]);

    const subtypes = new Set<string>([
      ...openingMap.keys(),
      ...movements.map(m => m.subtype),
    ]);

    const columnMap = new Map<string, EquityColumn>();
    for (const subtype of subtypes) {
      columnMap.set(subtype, {
        subtype,
        label:        subtypeLabel(subtype),
        opening:      openingMap.get(subtype) ?? 0,
        profitForYear: 0,
        dividends:    0,
        shareIssue:   0,
        revaluation:  0,
        closing:      0,
      });
    }

    for (const mv of movements) {
      const col = columnMap.get(mv.subtype);
      if (!col) continue;
      if (mv.movementType === 'profit')       col.profitForYear += mv.amount;
      else if (mv.movementType === 'dividend')    col.dividends    += mv.amount;
      else if (mv.movementType === 'share_issue') col.shareIssue   += mv.amount;
      else if (mv.movementType === 'revaluation') col.revaluation  += mv.amount;
    }

    for (const col of columnMap.values()) {
      col.closing = col.opening + col.profitForYear + col.dividends + col.shareIssue + col.revaluation;
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
      totalOpening:      sum('opening'),
      totalProfitForYear: sum('profitForYear'),
      totalDividends:    sum('dividends'),
      totalShareIssue:   sum('shareIssue'),
      totalRevaluation:  sum('revaluation'),
      totalClosing:      sum('closing'),
    };
  } catch (err) {
    log.error('Failed to generate changes in equity', { error: err }, 'accounting');
    throw err;
  }
}
