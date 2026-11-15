/**
 * The ONE statement behind GET /api/accounting/bank-account-summaries (WP1 PR-B; types and mapper in
 * ./bankAccountSummaryService). Per company: every leaf bank account (the same leaf-only rule and group-parent join as
 * `getBankAccountsStatus`), its line counts by bucket, its ledger balance, and its latest statement.
 *
 *   - Counts: one pass over the account's lines (`bt.company_id` AND `bt.bank_account_id`), FILTERed on the bucket
 *     (./bankLineBucket LINE_BUCKET_SQL) and the New tab (./bankTxTabCond NEW_TAB_SQL). Posted lines only, except
 *     `pending_at_bank`. In / out are the to-code lines' amounts split by sign, in integer cents.
 *   - Ledger: `bankGlBalanceAsAt` as at `as_at` (today in SAST unless the caller pins it) — the reconciliation's own
 *     definition (K-020): posted journals, both companies checked, entry_date <= as_at. It equals the Trial Balance
 *     bank row at period end; `gl_accounts.bank_opening_balance` (display metadata, no journal) is never added.
 *   - Statement: `latest` = newest batch by statement_date, then import time, then id; `last_with_balance` = the newest
 *     in that order carrying a closing balance (an `ai_read` one included: it is a figure, labelled as read by AI).
 *     Both skip a batch with no live line left. The difference is that closing balance less the ledger AS AT THAT
 *     STATEMENT'S DATE — the same formula for an asset bank account and a credit-card (liability) one (Hein
 *     2026-11-15). Line counts are live (lines naming the batch now, not removed).
 *   - Inactive accounts: returned only while they still hold a ledger balance or lines awaiting review.
 *
 * Money leaves Postgres as `ROUND(x * 100)::BIGINT`, so no float ever touches a figure.
 *
 * Read-only: plain SELECTs, no row locks, nothing written.
 *
 * `p` is a one-row CTE LEFT JOINed to the account rows, so a company with no bank account still gets its `as_at`
 * (one row whose account columns are NULL).
 */
import { sql } from '@/lib/neon';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { LINE_BUCKET_SQL } from './bankLineBucket';
import { NEW_TAB_SQL } from './bankTxTabCond';
import { bankGlBalanceAsAt } from './bankReconciliationBalance';

/**
 * The newest batch of account `a` (optionally: the newest carrying a closing balance), with its live line count. A
 * batch with no live line is skipped: every line it wrote was undone or deleted, so its balances describe lines that
 * are no longer there (team-lead decision, 2026-11-15).
 */
function newestBatch(withBalance: boolean) {
  return sql`
    SELECT b.id, b.statement_date, b.bank_format, b.import_channel, b.balance_source, b.created_at,
           ROUND(b.opening_balance * 100)::BIGINT AS opening_cents,
           ROUND(b.closing_balance * 100)::BIGINT AS closing_cents,
           (SELECT COUNT(*)::INT FROM bank_transactions x
             WHERE x.company_id = b.company_id AND x.import_batch_id = b.id
               AND x.feed_state <> 'removed') AS line_count
    FROM bank_import_batches b
    WHERE b.company_id = a.company_id AND b.bank_account_id = a.id
      ${sql.unsafe(withBalance ? 'AND b.closing_balance IS NOT NULL' : '')}
      AND EXISTS (SELECT 1 FROM bank_transactions x
                   WHERE x.company_id = b.company_id AND x.import_batch_id = b.id AND x.feed_state <> 'removed')
    ORDER BY b.statement_date DESC NULLS LAST, b.created_at DESC, b.id DESC
    LIMIT 1`;
}

/** `asAt` null = today in SAST. */
export function bankAccountSummaryQuery(companyId: string, asAt: string | null) {
  const subtypes = BANK_SUBTYPES as string[];
  const bucket = sql.unsafe(LINE_BUCKET_SQL);
  const newTab = sql.unsafe(NEW_TAB_SQL);
  return sql`
    WITH p AS (
      SELECT COALESCE(${asAt}::DATE, (NOW() AT TIME ZONE 'Africa/Johannesburg')::DATE) AS as_at
    ),
    accts AS (
      SELECT ga.id, ga.company_id, ga.account_code, ga.account_name, ga.account_type, ga.bank_account_number,
             ga.is_active, gp.id AS group_id, gp.account_name AS group_name, gp.account_code AS group_code
      FROM gl_accounts ga
      LEFT JOIN gl_accounts gp
        ON gp.id = ga.parent_account_id AND gp.company_id = ga.company_id AND gp.account_subtype = ANY(${subtypes})
      WHERE ga.company_id = ${companyId}::UUID
        AND ga.account_subtype = ANY(${subtypes})
        AND NOT EXISTS (
          SELECT 1 FROM gl_accounts child
           WHERE child.parent_account_id = ga.id AND child.company_id = ga.company_id
             AND child.account_subtype = ANY(${subtypes}))
    ),
    summary AS (
      SELECT a.id, a.account_code, a.account_name, a.account_type, a.bank_account_number, a.is_active,
             a.group_id, a.group_name, a.group_code,
             n.posted, n.allocated, n.provisional, n.suggested, n.unallocated, n.excluded,
             n.awaiting_review, n.pending_at_bank, n.to_code_in_cents, n.to_code_out_cents, n.last_date,
             led.ledger_cents,
             lt.id AS lt_id, lt.statement_date AS lt_statement_date, lt.bank_format AS lt_bank_format,
             lt.import_channel AS lt_import_channel, lt.balance_source AS lt_balance_source,
             lt.opening_cents AS lt_opening_cents, lt.closing_cents AS lt_closing_cents,
             lt.line_count AS lt_line_count, lt.created_at AS lt_created_at,
             lb.id AS lb_id, lb.statement_date AS lb_statement_date, lb.bank_format AS lb_bank_format,
             lb.import_channel AS lb_import_channel, lb.balance_source AS lb_balance_source,
             lb.opening_cents AS lb_opening_cents, lb.closing_cents AS lb_closing_cents,
             lb.line_count AS lb_line_count, lb.created_at AS lb_created_at,
             ls.cents AS ledger_at_statement_cents
      FROM accts a
      CROSS JOIN p
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE l.feed_state = 'posted')::INT AS posted,
          COUNT(*) FILTER (WHERE l.bucket = 'allocated')::INT AS allocated,
          COUNT(*) FILTER (WHERE l.bucket = 'allocated' AND l.status = 'provisional')::INT AS provisional,
          COUNT(*) FILTER (WHERE l.bucket = 'suggested')::INT AS suggested,
          COUNT(*) FILTER (WHERE l.bucket = 'unallocated')::INT AS unallocated,
          COUNT(*) FILTER (WHERE l.bucket = 'excluded')::INT AS excluded,
          COUNT(*) FILTER (WHERE l.feed_state = 'posted' AND l.is_new)::INT AS awaiting_review,
          COUNT(*) FILTER (WHERE l.feed_state = 'pending')::INT AS pending_at_bank,
          ROUND(COALESCE(SUM(l.amount) FILTER (WHERE l.bucket IN ('suggested', 'unallocated') AND l.amount > 0), 0)
                * 100)::BIGINT AS to_code_in_cents,
          ROUND(COALESCE(SUM(l.amount) FILTER (WHERE l.bucket IN ('suggested', 'unallocated') AND l.amount < 0), 0)
                * 100)::BIGINT AS to_code_out_cents,
          MAX(l.transaction_date) FILTER (WHERE l.feed_state = 'posted') AS last_date
        FROM (
          SELECT bt.feed_state, bt.status, bt.amount, bt.transaction_date,
                 (${bucket}) AS bucket, ${newTab} AS is_new
          FROM bank_transactions bt
          WHERE bt.company_id = a.company_id AND bt.bank_account_id = a.id
        ) l
      ) n
      CROSS JOIN LATERAL (
        SELECT ROUND(bal.gl_balance * 100)::BIGINT AS ledger_cents
        FROM (${bankGlBalanceAsAt(companyId, sql`a.id`, sql`p.as_at`)}) bal
      ) led
      LEFT JOIN LATERAL (${newestBatch(false)}) lt ON TRUE
      LEFT JOIN LATERAL (${newestBatch(true)}) lb ON TRUE
      LEFT JOIN LATERAL (
        SELECT ROUND(bal.gl_balance * 100)::BIGINT AS cents
        FROM (${bankGlBalanceAsAt(companyId, sql`a.id`, sql`lb.statement_date`)}) bal
        WHERE lb.id IS NOT NULL
      ) ls ON TRUE
      WHERE a.is_active OR led.ledger_cents <> 0 OR n.awaiting_review > 0
    )
    SELECT p.as_at, s.*
    FROM p
    LEFT JOIN summary s ON TRUE
    ORDER BY s.account_code, s.id`;
}
