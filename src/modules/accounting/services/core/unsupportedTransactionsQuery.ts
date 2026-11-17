/**
 * "Which bank transactions over R x have no supporting evidence" — list_unsupported_transactions' query.
 *
 * Two kinds of evidence, never merged into one flag:
 *  - own: a document on the line itself (bank/bankLineDocumentSql.hasBankLineDocumentSql, the paperclip's definition);
 *  - settled_document: the line pays or receives a bill / invoice that carries its own document
 *    (bank/settledDocumentSql.hasSettledDocumentSql).
 * Default: unsupported = neither kind. `strict` keeps the old answer: unsupported = no OWN document, whatever it settles.
 * This is an audit read only; the VAT input-support report does not use it (settled evidence never clears a VAT block).
 *
 * `excludeTransfers` drops lines that move money between the company's own accounts: an interbank transfer
 * (`transfer_journal_entry_id` / `counterparty_account_id`), or a line whose own bank-leg journal posts against a
 * money account (settlementKind's definition: a bank/cash subtype, or an account holding statement lines) or
 * against an account whose code is in `transferAccountCodes` (a clearing account such as 1560731; codes are
 * per-company, so the caller names them).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { hasBankLineDocumentSql } from '../bank/bankLineDocumentSql';
import { hasSettledDocumentSql } from '../bank/settledDocumentSql';
import { CASH_SUBTYPES } from '../gl/accountSubtypes';

export type Evidence = 'own' | 'settled_document' | 'none';

export interface UnsupportedTxRow {
  id: string;
  transactionDate: string;
  amount: number;
  description: string;
  reference: string | null;
  status: string;
  evidence: Evidence;
}

export interface UnsupportedFilters {
  from: string;
  to: string;
  /** Compared against ABS(amount): money out is as material as money in. */
  minAmount: number;
  limit: number;
  /** Unsupported = no OWN document (the old behaviour). Default false: no evidence of either kind. */
  strict?: boolean;
  excludeTransfers?: boolean;
  /** With excludeTransfers: account codes that are transfer / clearing accounts for this company. */
  transferAccountCodes?: readonly string[];
}

export interface UnsupportedPage {
  rows: UnsupportedTxRow[];
  /** Unsupported lines in scope (the rows' total before the limit). */
  rowsTotal: number;
  /** Transactions in range over the threshold (after excludeTransfers), supported or not. */
  universeTotal: number;
  withOwnDocument: number;
  /** No own document, but a settled bill / invoice carries one. */
  withSettledDocument: number;
  noEvidence: number;
  postedThrough: string;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

/**
 * The line moves money between the company's own accounts. Money account = settlementKind's definition (a bank / cash
 * subtype, or an account holding statement lines), written here as an UNcorrelated set of the company's statement
 * accounts: hashed once, where a per-line EXISTS on bank_transactions seq-scanned it for every line (8.7 s at 10k lines).
 */
function transferSql(companyId: string, codes: readonly string[]) {
  return sql`(bt.transfer_journal_entry_id IS NOT NULL OR bt.counterparty_account_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM gl_journal_lines bl
    JOIN gl_journal_lines cl ON cl.journal_entry_id = bl.journal_entry_id AND cl.company_id = bl.company_id AND cl.id <> bl.id
    JOIN gl_accounts ga ON ga.id = cl.gl_account_id AND ga.company_id = bt.company_id
    WHERE bl.id = bt.matched_journal_line_id AND bl.gl_account_id = bt.bank_account_id AND bl.company_id = bt.company_id
      AND (ga.account_code = ANY(${[...codes]}::TEXT[])
        OR COALESCE(ga.account_subtype = ANY(${[...CASH_SUBTYPES]}::TEXT[]), FALSE)
        OR ga.id IN (SELECT mbt.bank_account_id FROM bank_transactions mbt WHERE mbt.company_id = ${companyId}::UUID))
  ))`;
}

export async function listTransactionsWithoutDocuments(
  companyId: string,
  f: UnsupportedFilters,
): Promise<UnsupportedPage> {
  const notTransfer = f.excludeTransfers ? sql`AND NOT ${transferSql(companyId, f.transferAccountCodes ?? [])}` : sql``;
  const unsupported = f.strict ? sql`NOT s.own` : sql`NOT s.own AND NOT s.settled`;
  const scope = sql`
    SELECT bt.id, bt.transaction_date, bt.amount, bt.description, bt.reference, bt.status, bt.created_at,
           ${sql.unsafe(hasBankLineDocumentSql('bt'))} AS own,
           ${sql.unsafe(hasSettledDocumentSql('bt'))} AS settled
      FROM bank_transactions bt
     WHERE bt.company_id = ${companyId}::UUID
       AND bt.transaction_date >= ${f.from}::DATE
       AND bt.transaction_date <= ${f.to}::DATE
       AND ABS(bt.amount) >= ${f.minAmount}
       AND bt.feed_state = 'posted'
       ${notTransfer}`;
  try {
    // ONE statement over a MATERIALIZED scope: each line's own / settled evidence is computed once (a flattened
    // subquery re-evaluated both correlated booleans once per FILTER below, and per query), the totals come from the
    // same rows, and the page is a LATERAL over them. Always one result row (the totals); r.id is NULL on an empty page.
    const rows = (await sql`
      WITH s AS MATERIALIZED (${scope}),
      t AS (
        SELECT COUNT(*) AS universe,
               COUNT(*) FILTER (WHERE s.own) AS with_own,
               COUNT(*) FILTER (WHERE NOT s.own AND s.settled) AS with_settled,
               COUNT(*) FILTER (WHERE NOT s.own AND NOT s.settled) AS no_evidence,
               COUNT(*) FILTER (WHERE ${unsupported}) AS unsupported,
               MAX(s.created_at) FILTER (WHERE ${unsupported}) AS latest
          FROM s
      )
      SELECT t.*, r.id, r.transaction_date, r.amount, r.description, r.reference, r.status, r.own, r.settled
        FROM t
        LEFT JOIN LATERAL (
          SELECT s.* FROM s WHERE ${unsupported} ORDER BY ABS(s.amount) DESC, s.id DESC LIMIT ${f.limit}
        ) r ON true
    `) as DbRow[];
    const totals = rows[0];
    const page = rows.filter((r) => r.id != null);

    return {
      rows: page.map((r) => ({
        id: String(r.id),
        transactionDate: fmtDate(r.transaction_date),
        amount: Number(r.amount ?? 0),
        description: String(r.description ?? ''),
        reference: r.reference != null ? String(r.reference) : null,
        status: String(r.status ?? ''),
        evidence: r.own ? 'own' : r.settled ? 'settled_document' : 'none',
      })),
      rowsTotal: Number(totals?.unsupported ?? 0),
      universeTotal: Number(totals?.universe ?? 0),
      withOwnDocument: Number(totals?.with_own ?? 0),
      withSettledDocument: Number(totals?.with_settled ?? 0),
      noEvidence: Number(totals?.no_evidence ?? 0),
      postedThrough: totals?.latest != null ? iso(totals.latest) : new Date(0).toISOString(),
    };
  } catch (err) {
    log.error('Failed to list unsupported transactions', { companyId, error: err }, 'accounting');
    throw err;
  }
}
