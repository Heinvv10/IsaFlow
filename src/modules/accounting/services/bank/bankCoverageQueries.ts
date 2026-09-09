/**
 * The four queries behind `bank_statement_coverage`.
 *
 * Split from the service so the orchestration is testable without a database
 * and the SQL is reviewable on its own. Every query is scoped by `company_id`
 * and every one of them covers EVERY bank-subtype account — `is_active` is a
 * picker flag and a deactivated account still holds money (Brightsphere's
 * account 1110 is deactivated and carries R6,550 of cash today).
 *
 * A note on the reference column: the statement reference lives in `reference`.
 * `bank_reference` holds a feed's external id and is empty on every production
 * row, so the duplicate check reads `reference` first and falls back — the same
 * order `findBankTransactionsByReference` settled on.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export interface CoverageAccountRow {
  bankAccountId: string;
  accountCode: string;
  accountName: string;
  isActive: boolean;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  transactionCount: number;
  /** SUM(amount) of every transaction up to and including the reporting date. */
  netMovement: number;
  openingBalanceAmount: number | null;
  openingBalanceAsAt: string | null;
  /** MAX(created_at) of the transactions read, ISO-8601 or null. */
  latestImportedAt: string | null;
}

export interface CoverageMonthRow {
  bankAccountId: string;
  /** YYYY-MM. */
  month: string;
  transactionCount: number;
  net: number;
  debits: number;
  credits: number;
}

export interface CoverageGapRow {
  bankAccountId: string;
  /** Last date that HAS a transaction before the gap. */
  afterDate: string;
  /** First date that has one again. */
  beforeDate: string;
  /** Calendar days with no transaction between the two, exclusive. */
  missingDays: number;
}

export interface DuplicateReferenceRow {
  bankAccountId: string;
  reference: string;
  count: number;
  totalAmount: number;
  transactionIds: string[];
}

function isoTimestamp(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  return String(raw);
}

/**
 * Every bank-subtype account, with its transaction envelope and its recorded
 * opening balance.
 *
 * The LEFT JOIN is what keeps an account with ZERO transactions in the result,
 * and that row is the most important one in the report: an account that has
 * never received a statement line is what a whole missing import looks like.
 * The date bound sits in the join's ON clause and the aggregates are written to
 * survive a NULL, rather than being moved to a WHERE that would delete the
 * account.
 */
export async function fetchCoverageAccounts(
  companyId: string,
  asAt: string,
  bankAccountId?: string,
): Promise<CoverageAccountRow[]> {
  const rows = (await sql`
    SELECT ga.id,
           ga.account_code,
           ga.account_name,
           ga.is_active,
           ga.bank_opening_balance,
           ga.bank_opening_balance_date,
           COUNT(bt.id)::int                       AS txn_count,
           COALESCE(SUM(bt.amount), 0)::numeric    AS net_movement,
           MIN(bt.transaction_date)                AS first_date,
           MAX(bt.transaction_date)                AS last_date,
           MAX(bt.created_at)                      AS latest_imported_at
      FROM gl_accounts ga
      LEFT JOIN bank_transactions bt
             ON bt.bank_account_id   = ga.id
            AND bt.company_id        = ${companyId}::UUID
            AND bt.transaction_date <= ${asAt}::DATE
     WHERE ga.company_id      = ${companyId}::UUID
       AND ga.account_subtype = 'bank'
       AND ga.account_type    = 'asset'
       AND (${bankAccountId ?? null}::UUID IS NULL OR ga.id = ${bankAccountId ?? null}::UUID)
     GROUP BY ga.id, ga.account_code, ga.account_name, ga.is_active,
              ga.bank_opening_balance, ga.bank_opening_balance_date
     ORDER BY ga.account_code
  `) as DbRow[];

  return rows.map((r) => ({
    bankAccountId: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    isActive: r.is_active === true,
    firstTransactionDate: r.first_date === null || r.first_date === undefined ? null : fmtDate(r.first_date),
    lastTransactionDate: r.last_date === null || r.last_date === undefined ? null : fmtDate(r.last_date),
    transactionCount: Number(r.txn_count ?? 0),
    netMovement: Number(r.net_movement ?? 0),
    openingBalanceAmount:
      r.bank_opening_balance === null || r.bank_opening_balance === undefined
        ? null
        : Number(r.bank_opening_balance),
    openingBalanceAsAt:
      r.bank_opening_balance_date === null || r.bank_opening_balance_date === undefined
        ? null
        : fmtDate(r.bank_opening_balance_date),
    latestImportedAt: isoTimestamp(r.latest_imported_at),
  }));
}

/** Count and net movement by calendar month — the shape a hole shows up in. */
export async function fetchCoverageMonths(
  companyId: string,
  asAt: string,
  bankAccountId?: string,
): Promise<CoverageMonthRow[]> {
  const rows = (await sql`
    SELECT bt.bank_account_id,
           to_char(bt.transaction_date, 'YYYY-MM')                                 AS month,
           COUNT(*)::int                                                            AS txn_count,
           COALESCE(SUM(bt.amount), 0)::numeric                                     AS net,
           COALESCE(SUM(CASE WHEN bt.amount < 0 THEN -bt.amount ELSE 0 END), 0)::numeric AS debits,
           COALESCE(SUM(CASE WHEN bt.amount > 0 THEN  bt.amount ELSE 0 END), 0)::numeric AS credits
      FROM bank_transactions bt
     WHERE bt.company_id        = ${companyId}::UUID
       AND bt.transaction_date <= ${asAt}::DATE
       AND (${bankAccountId ?? null}::UUID IS NULL OR bt.bank_account_id = ${bankAccountId ?? null}::UUID)
     GROUP BY bt.bank_account_id, month
     ORDER BY bt.bank_account_id, month
  `) as DbRow[];

  return rows.map((r) => ({
    bankAccountId: String(r.bank_account_id),
    month: String(r.month),
    transactionCount: Number(r.txn_count),
    net: Number(r.net),
    debits: Number(r.debits),
    credits: Number(r.credits),
  }));
}

/**
 * Runs of consecutive days, INSIDE the account's own history, with no
 * transaction at all.
 *
 * Computed from the distinct transaction dates with a window function rather
 * than a generated calendar: the question is "how far apart are two consecutive
 * statement lines", and that needs no calendar table and no date arithmetic in
 * JS. Weekends make short gaps ordinary, which is why the caller sets a floor.
 */
export async function fetchCoverageGaps(
  companyId: string,
  asAt: string,
  minGapDays: number,
  bankAccountId?: string,
): Promise<CoverageGapRow[]> {
  const rows = (await sql`
    SELECT bank_account_id, d AS after_date, nd AS before_date, (nd - d - 1)::int AS missing_days
      FROM (
        SELECT bank_account_id,
               d,
               LEAD(d) OVER (PARTITION BY bank_account_id ORDER BY d) AS nd
          FROM (
            SELECT DISTINCT bt.bank_account_id, bt.transaction_date AS d
              FROM bank_transactions bt
             WHERE bt.company_id        = ${companyId}::UUID
               AND bt.transaction_date <= ${asAt}::DATE
               AND (${bankAccountId ?? null}::UUID IS NULL
                    OR bt.bank_account_id = ${bankAccountId ?? null}::UUID)
          ) dates
      ) windowed
     WHERE nd IS NOT NULL
       AND (nd - d - 1) >= ${minGapDays}
     ORDER BY bank_account_id, d
  `) as DbRow[];

  return rows.map((r) => ({
    bankAccountId: String(r.bank_account_id),
    afterDate: fmtDate(r.after_date),
    beforeDate: fmtDate(r.before_date),
    missingDays: Number(r.missing_days),
  }));
}

/**
 * References carried by more than one transaction on the same account.
 *
 * 914 duplicated references were found by hand on one company, which is what
 * makes `reference` unusable as a natural key — and is why the allocation tools
 * refuse an ambiguous reference rather than taking the first match.
 */
export async function fetchDuplicateReferences(
  companyId: string,
  asAt: string,
  bankAccountId?: string,
  maxIdsPerGroup = 10,
): Promise<DuplicateReferenceRow[]> {
  const rows = (await sql`
    SELECT bank_account_id, ref,
           COUNT(*)::int                        AS cnt,
           COALESCE(SUM(amount), 0)::numeric    AS total_amount,
           (array_agg(id::text ORDER BY transaction_date, id))[1:${maxIdsPerGroup}] AS ids
      FROM (
        SELECT bt.id, bt.bank_account_id, bt.amount, bt.transaction_date,
               COALESCE(NULLIF(btrim(bt.reference), ''), NULLIF(btrim(bt.bank_reference), '')) AS ref
          FROM bank_transactions bt
         WHERE bt.company_id        = ${companyId}::UUID
           AND bt.transaction_date <= ${asAt}::DATE
           AND (${bankAccountId ?? null}::UUID IS NULL
                OR bt.bank_account_id = ${bankAccountId ?? null}::UUID)
      ) refs
     WHERE ref IS NOT NULL
     GROUP BY bank_account_id, ref
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, ref
  `) as DbRow[];

  return rows.map((r) => ({
    bankAccountId: String(r.bank_account_id),
    reference: String(r.ref),
    count: Number(r.cnt),
    totalAmount: Number(r.total_amount),
    transactionIds: Array.isArray(r.ids) ? (r.ids as unknown[]).map(String) : [],
  }));
}
