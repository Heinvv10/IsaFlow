/**
 * The general ledger as a FLAT, totally-ordered, keyset-paginated line stream.
 *
 * `getGeneralLedgerReport` returns every account with its transactions nested,
 * in one unbounded response. That is right for a page that renders the whole
 * ledger and impossible for MCP: Velocity's posted ledger is 21,871 lines
 * across 111 accounts, and there is nothing to page over until the lines are
 * flat and in a total order.
 *
 * ── THE RUNNING BALANCE, AND WHY IT IS COMPUTED THE EXPENSIVE WAY ──────────
 *
 * `runningBalance` is the account's OPENING balance plus its cumulative
 * movement to and including that line. Two ways to produce it across pages:
 *
 *   1. carry the balance in the cursor and continue from it;
 *   2. compute the window over the whole period, then apply the keyset.
 *
 * This does (2). A cursor-carried balance is a figure the CALLER supplies, and
 * a stale, hand-edited or out-of-order cursor then produces a running balance
 * that is wrong and looks authoritative — on a ledger, the single worst
 * failure available. (2) recomputes the window each page, which costs a scan of
 * at most ~22k rows on the largest production company and is measured in
 * milliseconds. Correctness that does not depend on the caller is worth that.
 *
 * It also means a page's balances are IDENTICAL at any page size, which is what
 * the DB-gated test asserts.
 *
 * ── WHAT IS SUPPRESSED, AND WHY THAT IS NOT TIMIDITY ───────────────────────
 *
 * A LINE-LEVEL filter (`sources`, `minAmount`, `search`) selects some of an
 * account's lines. A running total over those is not a balance the account ever
 * held, so `runningBalance` is `null` and `runningBalanceSuppressed` says so.
 * An ACCOUNT-level filter (`accountCodes`, `accountIds`, `accountTypes`)
 * selects whole accounts and leaves each one's sequence intact, so the balances
 * survive and equal the ones the full ledger reports.
 *
 * `balanced` is `null` under ANY filter. Debits equalling credits is a property
 * of the complete period — every posted journal balances, so a whole-period
 * slice must — and over a subset it is a coincidence, not a check.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import {
  BALANCE_TOLERANCE,
  EMPTY_TOTALS,
  openingMap,
  round2,
  toIso,
  type GeneralLedgerCursor,
  type GeneralLedgerLine,
  type GeneralLedgerPage,
  type GeneralLedgerQuery,
  type StreamTotals,
} from './generalLedgerStreamTypes';

export type {
  GeneralLedgerCursor,
  GeneralLedgerLine,
  GeneralLedgerPage,
  GeneralLedgerQuery,
} from './generalLedgerStreamTypes';

/**
 * Every filter is passed as an array, and an EMPTY array disables its clause —
 * `cardinality(...) = 0 OR ...`. Branching the SQL text per filter combination
 * would produce sixteen statements of which the tests exercise two, and this
 * module already learned that lesson: `unappliedCashService` has two hand-
 * written queries because a single parameterised one type-checked, ran without
 * error and returned nothing.
 */
export async function getGeneralLedgerLines(
  query: GeneralLedgerQuery,
): Promise<GeneralLedgerPage> {
  const {
    companyId, periodStart, periodEnd, limit,
    accountCodes = [], accountIds = [], accountTypes = [],
    sources = [], minAmount, search, after = null,
  } = query;

  const lineLevelFilter =
    sources.length > 0 || minAmount !== undefined || (search !== undefined && search !== '');
  const anyFilter =
    lineLevelFilter || accountCodes.length > 0 || accountIds.length > 0 || accountTypes.length > 0;

  const codes = [...accountCodes];
  const ids = [...accountIds];
  const types = [...accountTypes];
  const srcs = [...sources];
  // A null threshold disables the clause; 0 would admit every line and read as
  // "no filter" while still suppressing the running balance.
  const minAmt = minAmount ?? null;
  const term = search === undefined || search === '' ? null : `%${search}%`;

  try {
    const rows = (await sql`
      WITH matched AS (
        SELECT jl.id AS line_id, jl.journal_entry_id, ga.id AS account_id,
               ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
               je.entry_date, je.entry_number, je.description, je.source,
               jl.debit, jl.credit, je.created_at,
               to_char(je.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS created_key,
               SUM(CASE WHEN ga.normal_balance = 'debit'
                        THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END)
                 OVER (PARTITION BY ga.id
                       ORDER BY je.entry_date, je.created_at, jl.id
                       ROWS UNBOUNDED PRECEDING) AS cumulative,
               -- The window's order and the page's order MUST be the same, or
               -- the running balance does not follow the rows it is printed
               -- beside. to_char of a timestamp in this format is fixed-width,
               -- so ordering the text equals ordering the timestamp.
               1 AS order_guard
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
                           AND ga.company_id = ${companyId}::UUID
        WHERE jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${periodStart}::DATE
          AND je.entry_date <= ${periodEnd}::DATE
          AND (cardinality(${codes}::text[]) = 0 OR ga.account_code = ANY(${codes}::text[]))
          AND (cardinality(${ids}::uuid[])  = 0 OR ga.id            = ANY(${ids}::uuid[]))
          AND (cardinality(${types}::text[]) = 0 OR ga.account_type = ANY(${types}::text[]))
          AND (cardinality(${srcs}::text[])  = 0 OR COALESCE(je.source, 'manual') = ANY(${srcs}::text[]))
          AND (${minAmt}::NUMERIC IS NULL
               OR GREATEST(jl.debit, jl.credit) >= ${minAmt}::NUMERIC)
          AND (${term}::TEXT IS NULL
               OR je.entry_number ILIKE ${term}::TEXT
               OR COALESCE(je.description, '') ILIKE ${term}::TEXT)
      ),
      -- The period BEFORE any filter. Deliberately a separate scan rather than
      -- a count over the matched set: that set is where the filters live, so
      -- any count taken from it is a filtered count by construction.
      -- (No backticks in here: they close the template literal.)
      universe AS (
        SELECT COUNT(*) AS universe_count
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
        WHERE jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${periodStart}::DATE
          AND je.entry_date <= ${periodEnd}::DATE
      ),
      totals AS (
        SELECT COUNT(*) AS line_count,
               COALESCE(SUM(debit), 0)  AS total_debit,
               COALESCE(SUM(credit), 0) AS total_credit,
               COUNT(DISTINCT account_id) AS account_count,
               MAX(created_at) AS posted_through
        FROM matched
      ),
      -- Opening balances for the accounts in the filtered set, from everything
      -- posted BEFORE the window. Restricted to the accounts matched above, so
      -- an account nobody selected is not carried and the account filters are
      -- expressed once. (No backticks in here: they close the template literal.)
      opening_raw AS (
        SELECT ga.account_code,
               SUM(CASE WHEN ga.normal_balance = 'debit'
                        THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END) AS balance
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
                           AND ga.company_id = ${companyId}::UUID
        WHERE jl.company_id = ${companyId}::UUID
          AND je.entry_date < ${periodStart}::DATE
          AND ga.account_code IN (SELECT account_code FROM matched)
        GROUP BY ga.account_code
      ),
      -- EVERY account in the filtered set, with zero where it had no prior
      -- activity. An absent key and a zero balance are indistinguishable to a
      -- caller doing arithmetic, so the absent case is not offered.
      opening AS (
        SELECT c.account_code, COALESCE(o.balance, 0) AS balance
        FROM (SELECT DISTINCT account_code FROM matched) c
        LEFT JOIN opening_raw o ON o.account_code = c.account_code
      )
      SELECT m.*, t.line_count, t.total_debit, t.total_credit, t.account_count,
             t.posted_through, u.universe_count,
             COALESCE(o.balance, 0) AS opening_balance,
             -- The whole opening set, so accounts absent from THIS page still
             -- carry theirs: a page cut inside account B must not report B's
             -- opening balance as zero on the next call.
             (SELECT COALESCE(json_agg(json_build_object('c', account_code, 'b', balance)), '[]'::json)
              FROM opening) AS opening_all
      FROM matched m
      CROSS JOIN totals t
      CROSS JOIN universe u
      LEFT JOIN opening o ON o.account_code = m.account_code
      WHERE (${after === null}::BOOLEAN
             OR (m.account_code, m.entry_date, m.created_key, m.line_id)
                > (${after?.accountCode ?? ''}::TEXT, ${after?.date ?? '1900-01-01'}::DATE,
                   ${after?.createdKey ?? '1900-01-01 00:00:00.000000'}::TEXT,
                   ${after?.lineId ?? '00000000-0000-0000-0000-000000000000'}::UUID))
      -- TOTAL order. account_code and entry_date are not unique and created_at
      -- is not either; the line id is what makes the keyset lossless, and
      -- without it a page boundary drops or repeats rows in the middle of a
      -- ledger.
      ORDER BY m.account_code, m.entry_date, m.created_key, m.line_id
      LIMIT ${limit}
    `) as DbRow[];

    // The aggregates are on every row and identical; an empty page needs them
    // from somewhere else, so they are re-read rather than assumed present.
    const agg = rows[0];
    const totals =
      agg === undefined
        // `after === null` and no rows means the filtered set really is empty,
        // so the zeros are the truth. Re-reading in that case would recurse
        // forever, which is how a guard that looks defensive hangs a request.
        ? after === null
          ? EMPTY_TOTALS
          : await readTotalsOnly(query)
        : {
            lineCount: Number(agg.line_count ?? 0),
            universeLineCount: Number(agg.universe_count ?? 0),
            totalDebit: round2(Number(agg.total_debit ?? 0)),
            totalCredit: round2(Number(agg.total_credit ?? 0)),
            accountCount: Number(agg.account_count ?? 0),
            postedThrough: toIso(agg.posted_through),
            openingBalances: openingMap(agg.opening_all),
          };

    const lines: GeneralLedgerLine[] = rows.map((r) => ({
      lineId: String(r.line_id),
      journalEntryId: String(r.journal_entry_id),
      accountId: String(r.account_id),
      accountCode: String(r.account_code),
      accountName: String(r.account_name ?? ''),
      accountType: String(r.account_type ?? ''),
      normalBalance: String(r.normal_balance) === 'credit' ? 'credit' : 'debit',
      date: fmtDate(r.entry_date as string | Date),
      entryNumber: String(r.entry_number ?? ''),
      description: String(r.description ?? ''),
      source: String(r.source ?? 'manual'),
      debit: Number(r.debit ?? 0),
      credit: Number(r.credit ?? 0),
      runningBalance: lineLevelFilter
        ? null
        : round2(Number(r.opening_balance ?? 0) + Number(r.cumulative ?? 0)),
    }));

    const last = rows[rows.length - 1];
    const next =
      last !== undefined && rows.length === limit
        ? {
            accountCode: String(last.account_code),
            date: fmtDate(last.entry_date as string | Date),
            createdKey: String(last.created_key),
            lineId: String(last.line_id),
          }
        : null;

    return {
      lines,
      next,
      lineCount: totals.lineCount,
      universeLineCount: totals.universeLineCount,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      accountCount: totals.accountCount,
      balanced: anyFilter
        ? null
        : Math.abs(totals.totalDebit - totals.totalCredit) < BALANCE_TOLERANCE,
      runningBalanceSuppressed: lineLevelFilter,
      openingBalances: totals.openingBalances,
      postedThrough: totals.postedThrough,
    };
  } catch (err) {
    log.error('Failed to read general-ledger lines', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Totals when the page is empty.
 *
 * A page past the end of the stream returns no rows, and the aggregates ride on
 * the rows. Returning zeros instead would tell a caller that paged to the end
 * that the ledger it just read is empty.
 */
async function readTotalsOnly(query: GeneralLedgerQuery): Promise<StreamTotals> {
  const page = await getGeneralLedgerLines({ ...query, after: null, limit: 1 });
  return {
    lineCount: page.lineCount,
    universeLineCount: page.universeLineCount,
    totalDebit: page.totalDebit,
    totalCredit: page.totalCredit,
    accountCount: page.accountCount,
    postedThrough: page.postedThrough,
    openingBalances: page.openingBalances,
  };
}
