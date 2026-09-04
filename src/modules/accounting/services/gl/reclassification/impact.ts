/**
 * What a proposed reclassification would do to the numbers.
 *
 * TWO INDEPENDENTLY DERIVED SIDES, because the alternative is a tautology.
 * `after = before + what we claim to move` cannot disagree with itself, and
 * CONTRACTS.md §1 records two endpoints that shipped exactly that shape and
 * reported a clean identity while being wrong. So BOTH sides are full
 * aggregations over the ledger window: the `before` side groups every posted
 * line by its own account's type and subtype, and the `after` side groups the
 * same scan with the moved lines PROJECTED onto the target account. Neither is
 * computed from the other.
 *
 * Both are then folded by `gl/accountClassification#aggregateFigures` — the one
 * owned classifier every P&L in this codebase goes through. No new aggregate is
 * written here (CONTRACTS.md §5); what is new is the projection.
 *
 * AND THE FOLD IS CHECKED. The `before` side is compared against
 * `financialFiguresService#getFinancialFigures`, the owning service, band by
 * band. If this file's query has drifted from that one — a missing predicate, a
 * different date bound — the difference would otherwise be attributed to the
 * reclassification. `basisFault` says so instead of hiding it.
 */

import { sql } from '@/lib/neon';
import {
  aggregateFigures,
  type AccountType,
  type ClassificationRow,
  type ClassifiedFigures,
} from '../accountClassification';
import { getFinancialFigures } from '../financialFiguresService';

export interface ImpactWindow {
  start: string;
  end: string;
}

export interface AccountMovement {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Signed movement in the window, normal-balance direction. */
  before: number;
  after: number;
  /** Sum of |debit| + |credit| on the account in the window, before the move. */
  grossBefore: number;
  grossAfter: number;
  lineCountBefore: number;
  lineCountAfter: number;
}

export interface ReclassImpact {
  window: ImpactWindow;
  profitAndLossBefore: ClassifiedFigures;
  profitAndLossAfter: ClassifiedFigures;
  /** Source and target account movement, both sides from their own scan. */
  accounts: AccountMovement[];
  /**
   * Set when this file's `before` fold disagrees with the owning P&L service.
   * Absent means the two agree to the cent and the `after` side is being
   * compared against the same basis the rest of the system reports.
   */
  basisFault?: string;
}

interface FoldRow {
  side: string;
  account_type: AccountType;
  account_subtype: string | null;
  account_count: string | number;
  debit: string | number;
  credit: string | number;
}

interface AccountRow {
  side: string;
  gl_account_id: string;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  debit: string | number;
  credit: string | number;
  gross: string | number;
  line_count: string | number;
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

const round2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

/** The P&L bands worth comparing. The balance-sheet bands move too on a
 *  cross-type move, and are reported through `accounts` rather than here. */
const PL_BANDS = [
  'revenue', 'otherIncome', 'costOfSales', 'grossProfit',
  'operatingExpenses', 'otherExpenses', 'netProfit',
] as const;

function compareToOwner(mine: ClassifiedFigures, owner: ClassifiedFigures): string | undefined {
  const drift = PL_BANDS
    .filter((band) => Math.abs(mine[band] - owner[band]) >= 0.01)
    .map((band) => `${band}: ${round2(mine[band])} vs ${round2(owner[band])}`);
  return drift.length === 0
    ? undefined
    : `the before-side fold disagrees with financialFiguresService — ${drift.join('; ')}`;
}

export interface ImpactInput {
  companyId: string;
  window: ImpactWindow;
  /** Line ids that would move. Empty is legitimate — after equals before. */
  movedLineIds: readonly string[];
  sourceAccountId: string;
  targetAccountId: string;
  /** The target's own classification, applied to the projected lines. */
  targetAccountType: AccountType;
  targetAccountSubtype: string | null;
  /**
   * Code and name for each of the two accounts, from the ownership read the
   * caller has already done. Carried rather than re-queried so an account with
   * no lines in the window is still named — the target usually has none before.
   */
  accountLabels: Record<string, { code: string; name: string }>;
}

/**
 * `gl_accounts` is joined with a `company_id` predicate here and is NOT in
 * `getFinancialFigures`, which fences only the two journal tables. The ids are
 * uuids so the two agree on any sound ledger; the predicate is kept because a
 * cross-tenant `gl_account_id` would otherwise be summed into this company's
 * figures, and the `basisFault` check would report the divergence if one exists.
 */
export async function computeReclassImpact(input: ImpactInput): Promise<ReclassImpact> {
  const { window: win } = input;
  const moved = input.movedLineIds as string[];

  const folds = (await sql`
    WITH win AS (
      SELECT jl.id AS line_id, jl.gl_account_id, jl.debit, jl.credit,
             ga.account_type, ga.account_subtype
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je
          ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
        JOIN gl_accounts ga
          ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
       WHERE jl.company_id = ${input.companyId}::UUID
         AND je.status = 'posted'
         AND je.entry_date >= ${win.start}::DATE
         AND je.entry_date <= ${win.end}::DATE
    ),
    proj AS (
      SELECT CASE WHEN line_id = ANY(${moved}::UUID[])
                  THEN ${input.targetAccountId}::UUID ELSE gl_account_id END AS gl_account_id,
             CASE WHEN line_id = ANY(${moved}::UUID[])
                  THEN ${input.targetAccountType} ELSE account_type END AS account_type,
             CASE WHEN line_id = ANY(${moved}::UUID[])
                  THEN ${input.targetAccountSubtype} ELSE account_subtype END AS account_subtype,
             debit, credit
        FROM win
    )
    SELECT 'before' AS side, account_type, account_subtype,
           COUNT(DISTINCT gl_account_id) AS account_count,
           COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
      FROM win GROUP BY account_type, account_subtype
    UNION ALL
    SELECT 'after' AS side, account_type, account_subtype,
           COUNT(DISTINCT gl_account_id) AS account_count,
           COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
      FROM proj GROUP BY account_type, account_subtype
  `) as unknown as FoldRow[];

  const toRows = (side: string): ClassificationRow[] =>
    folds.filter((r) => r.side === side).map((r) => ({
      account_type: r.account_type,
      account_subtype: r.account_subtype,
      debit: r.debit,
      credit: r.credit,
      account_count: r.account_count,
    }));

  const before = aggregateFigures(toRows('before'));
  const after = aggregateFigures(toRows('after'));

  // The owner's own figure for the same window, for the independence check.
  const owner = (await getFinancialFigures(input.companyId, win.start, win.end)).period;

  const accounts = await accountMovements(input, moved);

  const fault = compareToOwner(before, owner);
  return {
    window: win,
    profitAndLossBefore: before,
    profitAndLossAfter: after,
    accounts,
    ...(fault === undefined ? {} : { basisFault: fault }),
  };
}

/**
 * The two accounts' own movement, before and after, from the same projection.
 *
 * This is the trial-balance half: a reader who wants to check the P&L delta
 * against the accounts it came from can, and the account codes are the route to
 * the lines behind each figure.
 */
async function accountMovements(
  input: ImpactInput,
  moved: string[],
): Promise<AccountMovement[]> {
  const ids = [input.sourceAccountId, input.targetAccountId];
  const rows = (await sql`
    WITH win AS (
      SELECT jl.id AS line_id, jl.gl_account_id, jl.debit, jl.credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je
          ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
       WHERE jl.company_id = ${input.companyId}::UUID
         AND je.status = 'posted'
         AND je.entry_date >= ${input.window.start}::DATE
         AND je.entry_date <= ${input.window.end}::DATE
    ),
    sides AS (
      SELECT 'before' AS side, gl_account_id, debit, credit FROM win
      UNION ALL
      SELECT 'after' AS side,
             CASE WHEN line_id = ANY(${moved}::UUID[])
                  THEN ${input.targetAccountId}::UUID ELSE gl_account_id END,
             debit, credit
        FROM win
    )
    SELECT s.side, s.gl_account_id, ga.account_code, ga.account_name, ga.account_type,
           COALESCE(SUM(s.debit), 0) AS debit,
           COALESCE(SUM(s.credit), 0) AS credit,
           COALESCE(SUM(s.debit + s.credit), 0) AS gross,
           COUNT(*) AS line_count
      FROM sides s
      JOIN gl_accounts ga ON ga.id = s.gl_account_id AND ga.company_id = ${input.companyId}::UUID
     WHERE s.gl_account_id = ANY(${ids}::UUID[])
     GROUP BY s.side, s.gl_account_id, ga.account_code, ga.account_name, ga.account_type
  `) as unknown as AccountRow[];

  return ids.map((id) => {
    const b = rows.find((r) => r.side === 'before' && r.gl_account_id === id);
    const a = rows.find((r) => r.side === 'after' && r.gl_account_id === id);
    const label = input.accountLabels[id] ?? { code: '', name: '' };
    const signed = (r: AccountRow | undefined): number => {
      if (!r) return 0;
      const debit = num(r.debit), credit = num(r.credit);
      return r.account_type === 'asset' || r.account_type === 'expense'
        ? debit - credit
        : credit - debit;
    };
    return {
      accountId: id,
      accountCode: label.code,
      accountName: label.name,
      before: round2(signed(b)),
      after: round2(signed(a)),
      grossBefore: round2(num(b?.gross)),
      grossAfter: round2(num(a?.gross)),
      lineCountBefore: Number(b?.line_count ?? 0),
      lineCountAfter: Number(a?.line_count ?? 0),
    };
  });
}
