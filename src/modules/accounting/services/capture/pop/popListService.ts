/**
 * Every filed proof of payment of a company with what became of it: the bank-line matcher's decision (991) and the
 * SharePoint copy (992). The read behind MCP `list_proofs_of_payment`; read-only.
 *
 * Runs as the caller's session (app_user under the company's tenant context: SELECT on all four tables, RLS), and
 * still names the company in every join and the WHERE, as every service does. The page rows, the total and the
 * summary splice ONE FROM + predicate, so the counts always describe the rows they stand for.
 *
 * A POP the matcher did not attach whose document is linked to a bank line anyway (a person attached it in the app)
 * is 'attached_manually': it needs no attention. "Linked" is bank/bankLineDocumentSql's `linkedCapturedDocSql`, the one
 * definition of "this captured document is one of this line's documents" (captured_documents.matched_bank_tx_id, the
 * document and the line in the same company, stored, not rejected), on a line not feed_state 'removed'.
 *
 * ORDER BY payment_date DESC, id DESC: a total order (many POPs share a date), so offset pages neither skip nor repeat.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { containsLikePattern } from '@/lib/sqlLikeLiteral';
import { linkedCapturedDocSql } from '../../bank/bankLineDocumentSql';
import {
  POP_ARCHIVE_STATUSES, POP_MATCH_STATUSES,
  type PopArchiveStatus, type PopMatchFilter, type PopMatchStatus,
} from './popListStatus';

export interface PopListFilters {
  matchStatus?: PopMatchFilter | null;
  archiveStatus?: PopArchiveStatus | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Case-insensitive substring of the beneficiary, matched literally (%, _ and \ are not wildcards). */
  beneficiary?: string | null;
}

export interface PopListRow {
  popId: string;
  transactionNumber: string;
  paymentDate: string;
  amount: number;
  beneficiary: string;
  payerProfile: string;
  capturedDocumentId: string;
  createdAt: string;
  match: {
    status: PopMatchStatus;
    /** The bank line the POP is on: the matcher's ('attached') or the one a person linked it to ('attached_manually'). */
    bankTransactionId: string | null;
    /** The lines a person should look at: every candidate of an 'ambiguous' POP, the refused line of a 'refused' one. */
    candidateBankTransactionIds: string[];
    refusal: string | null;
    /** When the matcher decided; for 'not_found', when it last looked. */
    checkedAt: string | null;
  };
  archive: {
    status: PopArchiveStatus;
    webUrl: string | null;
    path: string | null;
    settledAt: string | null;
    /** Failures that were this POP's own (they count toward 'failed'); null when it never failed. */
    attempts: number | null;
    /** Every failure, outages included. */
    tries: number | null;
    lastAttemptAt: string | null;
    lastError: string | null;
  };
}

export interface PopListSummary {
  byMatch: Record<PopMatchStatus, number>;
  byArchive: Record<PopArchiveStatus, number>;
}

export interface PopListPage {
  rows: PopListRow[];
  total: number;
  summary: PopListSummary;
  /** False when the company has no pop_archive_targets row: its POPs are never copied and stay 'pending'. */
  archiveConfigured: boolean;
}

function popListFrom() {
  return sql`
    FROM proof_of_payments p
    LEFT JOIN proof_of_payment_matches m ON m.proof_of_payment_id = p.id AND m.company_id = p.company_id
    LEFT JOIN pop_archive_copies c ON c.proof_of_payment_id = p.id AND c.company_id = p.company_id
    LEFT JOIN pop_archive_attempts a ON a.proof_of_payment_id = p.id AND a.company_id = p.company_id
    LEFT JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
    LEFT JOIN bank_transactions bt ON ${sql.unsafe(linkedCapturedDocSql('bt', 'cd'))} AND bt.feed_state <> 'removed'`;
}

/** The POP's match status (see the header), one expression for the rows, the filter and the summary. Built per call:
 *  a module-level `sql.unsafe` would run at import, under every test that mocks `@/lib/neon` without it. */
function matchStatusSql() {
  return sql.unsafe(`CASE WHEN m.outcome IS DISTINCT FROM 'attached' AND bt.id IS NOT NULL THEN 'attached_manually'
    ELSE COALESCE(m.outcome, 'pending') END`);
}

function popListWhere(companyId: string, f: PopListFilters) {
  const match = f.matchStatus || null;
  const archive = f.archiveStatus || null;
  const from = f.dateFrom || null;
  const to = f.dateTo || null;
  const term = containsLikePattern(f.beneficiary?.trim() || undefined);
  const status = matchStatusSql();
  return sql`p.company_id = ${companyId}::UUID
    AND (${match}::TEXT IS NULL
         OR (${match}::TEXT = 'unmatched' AND ${status} NOT IN ('attached', 'attached_manually'))
         OR ${status} = ${match}::TEXT)
    AND (${archive}::TEXT IS NULL OR COALESCE(c.outcome, 'pending') = ${archive}::TEXT)
    AND (${from}::DATE IS NULL OR p.payment_date >= ${from}::DATE)
    AND (${to}::DATE IS NULL OR p.payment_date <= ${to}::DATE)
    AND (${term}::TEXT IS NULL OR p.beneficiary ILIKE ${term}::TEXT ESCAPE '\\')`;
}

export async function listProofsOfPayment(
  companyId: string,
  f: PopListFilters & { limit: number; offset: number },
): Promise<PopListPage> {
  const from = popListFrom();
  const where = popListWhere(companyId, f);
  const status = matchStatusSql();
  // One after another: under MCP all three run on the request's one transaction client.
  const rows = await sql`
      SELECT p.id, p.transaction_number, to_char(p.payment_date, 'YYYY-MM-DD') AS payment_date, p.amount,
             p.beneficiary, p.payer_profile, p.captured_document_id, p.created_at,
             ${status} AS match_status, bt.id AS linked_bank_tx_id,
             m.candidate_bank_tx_ids::TEXT[] AS candidates, m.refusal, m.checked_at,
             c.outcome AS archive_outcome, c.web_url, c.path, c.archived_at,
             a.attempts, a.tries, a.last_attempt_at, a.last_error
      ${from}
      WHERE ${where}
      ORDER BY p.payment_date DESC, p.id DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`;
  const groups = await sql`
      SELECT ${status} AS match_status, COALESCE(c.outcome, 'pending') AS archive_status,
             COUNT(*) AS n
      ${from}
      WHERE ${where}
      GROUP BY 1, 2`;
  const target = await sql`SELECT EXISTS (SELECT 1 FROM pop_archive_targets WHERE company_id = ${companyId}::UUID) AS configured`;

  const byMatch = Object.fromEntries(POP_MATCH_STATUSES.map((s) => [s, 0])) as Record<PopMatchStatus, number>;
  const byArchive = Object.fromEntries(POP_ARCHIVE_STATUSES.map((s) => [s, 0])) as Record<PopArchiveStatus, number>;
  let total = 0;
  for (const g of groups as DbRow[]) {
    const n = Number(g.n);
    byMatch[g.match_status as PopMatchStatus] += n;
    byArchive[g.archive_status as PopArchiveStatus] += n;
    total += n;
  }
  return {
    rows: (rows as DbRow[]).map(toRow),
    total,
    summary: { byMatch, byArchive },
    archiveConfigured: Boolean((target as DbRow[])[0]?.configured),
  };
}

const str = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toRow(r: DbRow): PopListRow {
  const matchStatus = String(r.match_status) as PopMatchStatus;
  const onLine = matchStatus === 'attached' || matchStatus === 'attached_manually';
  const candidates = Array.isArray(r.candidates) ? (r.candidates as unknown[]).map(String) : [];
  return {
    popId: String(r.id),
    transactionNumber: String(r.transaction_number),
    paymentDate: String(r.payment_date),
    amount: Number(r.amount),
    beneficiary: String(r.beneficiary),
    payerProfile: String(r.payer_profile),
    capturedDocumentId: String(r.captured_document_id),
    createdAt: iso(r.created_at)!,
    match: {
      status: matchStatus,
      bankTransactionId: matchStatus === 'attached' ? (candidates[0] ?? null) : matchStatus === 'attached_manually' ? str(r.linked_bank_tx_id) : null,
      candidateBankTransactionIds: onLine ? [] : candidates,
      refusal: str(r.refusal),
      checkedAt: iso(r.checked_at),
    },
    archive: {
      status: (r.archive_outcome ?? 'pending') as PopArchiveStatus,
      webUrl: str(r.web_url),
      path: str(r.path),
      settledAt: iso(r.archived_at),
      attempts: num(r.attempts),
      tries: num(r.tries),
      lastAttemptAt: iso(r.last_attempt_at),
      lastError: str(r.last_error),
    },
  };
}
