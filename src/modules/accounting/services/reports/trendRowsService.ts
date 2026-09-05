/**
 * Twelve months of figures per account, for the statement trend column and
 * the small-multiples panel.
 *
 * Two functions, not one, because the two halves of the chart of accounts
 * want different series: a P&L account's twelve numbers are its monthly
 * MOVEMENT, a balance-sheet account's are its month-end BALANCE. Plotting a
 * movement series against an asset account draws a shape that has nothing to
 * do with the balance the statement prints next to it.
 *
 * Both series foot to the statement they sit beside, and that is what fixes
 * the sign conventions — they are copied from the statements, not chosen here:
 *
 * - Movement uses `incomeStatementService`'s per-line arithmetic: revenue is
 *   credit less debit, expense is debit less credit, so "more is more" on both
 *   sides and the sparkline rises when the line item rises.
 * - Balance uses `balanceSheetService`'s: sign by `normal_balance`, then NEGATE
 *   contra-assets (asset type, credit normal balance — Accumulated
 *   Depreciation). A plain debit-less-credit series would draw those accounts
 *   upside down against the number printed next to them. The same leaf filter
 *   applies, so a parent roll-up account does not get a series the balance
 *   sheet never prints.
 *
 * The balance series is a running sum seeded with the balance at the window's
 * open, so a month with no posting repeats the month before it rather than
 * dropping to zero. That carry-forward is the whole reason this differs from
 * the movement series, and reconstructing it from the returned rows alone
 * cannot work: a zero row and an absent row are indistinguishable once the
 * figures are shaped. Seeding from an opening balance removes the question.
 */
import { sql } from '@/lib/neon';

export interface AccountTrends {
  /** Twelve `YYYY-MM` keys, oldest first. */
  months: string[];
  /** Account code → twelve figures, aligned to `months`. */
  byAccountCode: Record<string, number[]>;
}

/** `month_key` is `OPENING_KEY` for everything posted before the window. */
const OPENING_KEY = 'opening';

interface TrendRow {
  account_code: string;
  month_key: string;
  amount: number | string;
}

/** The twelve `YYYY-MM` keys ending at `asOf`'s month, oldest first. */
export function monthKeys(asOf: string): string[] {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const keys: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

export async function getMonthlyMovements(companyId: string, asOf: string): Promise<AccountTrends> {
  const months = monthKeys(asOf);
  const windowStart = `${months[0]}-01`;

  const rows = (await sql`
    SELECT ga.account_code,
           to_char(date_trunc('month', je.entry_date), 'YYYY-MM') AS month_key,
           COALESCE(SUM(
             CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
                  ELSE jl.debit - jl.credit END), 0)::float8 AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_type IN ('revenue', 'expense')
      AND je.entry_date >= ${windowStart}::date
      AND je.entry_date <= ${asOf}::date
    GROUP BY ga.account_code, date_trunc('month', je.entry_date)
  `) as TrendRow[];

  const index = new Map(months.map((m, i) => [m, i]));
  const byAccountCode: Record<string, number[]> = {};
  for (const row of rows) {
    const slot = index.get(row.month_key);
    if (slot === undefined) continue;
    const series = (byAccountCode[row.account_code] ??= new Array<number>(12).fill(0));
    series[slot] = Number(row.amount);
  }
  return { months, byAccountCode };
}

export async function getMonthlyBalances(companyId: string, asOf: string): Promise<AccountTrends> {
  const months = monthKeys(asOf);
  const windowStart = `${months[0]}-01`;

  // One pass over the ledger from inception to as-of. Everything before the
  // window collapses into a single `opening` bucket; inside the window each
  // month is its own movement. The running sum below turns those into
  // balances.
  const rows = (await sql`
    SELECT ga.account_code,
           CASE WHEN je.entry_date < ${windowStart}::date THEN ${OPENING_KEY}
                ELSE to_char(date_trunc('month', je.entry_date), 'YYYY-MM')
           END AS month_key,
           COALESCE(SUM(
             -- balanceSheetService: sign by normal_balance, then negate the
             -- contra-asset. Both branches collapse to debit less credit for
             -- assets, which is why the two clauses look alike.
             CASE WHEN ga.account_type = 'asset' AND ga.normal_balance = 'credit'
                    THEN jl.debit - jl.credit
                  WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit
                  ELSE jl.credit - jl.debit END), 0)::float8 AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_type IN ('asset', 'liability', 'equity')
      AND je.entry_date <= ${asOf}::date
      AND (
        ga.level >= 3
        OR NOT EXISTS (
          SELECT 1 FROM gl_accounts child
          WHERE child.parent_account_id = ga.id
            AND child.company_id = ${companyId}::UUID
        )
      )
    -- Grouped by ordinal: the bucketing CASE carries bound parameters, and a
    -- repeat of it in GROUP BY binds NEW placeholders, which Postgres reads as
    -- a different expression ("je.entry_date must appear in the GROUP BY").
    GROUP BY 1, 2
  `) as TrendRow[];

  const index = new Map(months.map((m, i) => [m, i]));
  const opening: Record<string, number> = {};
  const movements: Record<string, number[]> = {};
  for (const row of rows) {
    if (row.month_key === OPENING_KEY) {
      opening[row.account_code] = (opening[row.account_code] ?? 0) + Number(row.amount);
      movements[row.account_code] ??= new Array<number>(12).fill(0);
      continue;
    }
    const slot = index.get(row.month_key);
    if (slot === undefined) continue;
    const series = (movements[row.account_code] ??= new Array<number>(12).fill(0));
    series[slot] = Number(row.amount);
  }

  const byAccountCode: Record<string, number[]> = {};
  for (const [code, series] of Object.entries(movements)) {
    let running = opening[code] ?? 0;
    byAccountCode[code] = series.map((movement) => (running += movement));
  }
  return { months, byAccountCode };
}
