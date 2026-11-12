/**
 * bankTransferLinkLog: the record of every automatic transfer link (migration 978).
 *
 * `applyTransferLinks` writes one `bank_transfer_link_log` row per link in the
 * same statement as the link, carrying the line's previous fields, so an undo
 * (bankTransferLinkUndo) can put the line back exactly. This file holds the
 * trigger type the passes carry, the "this pair was undone" veto both passes
 * apply, and the reader behind the Bank Transactions notice and log drawer.
 */

import { sql } from '@/lib/neon';
import { TRANSFER_LINK_MAX_BATCHES } from './bankTransferLinkLimits';

export type TransferLinkSource = 'page_load' | 'import';

/** What started a link pass: one batch id per page load or per import (both passes share it). */
export interface TransferLinkTrigger {
  source: TransferLinkSource;
  linkBatchId: string;
  importBatchId?: string;
}

export interface TransferLinkItem {
  id: string;
  bankTransactionId: string;
  transactionDate: string;
  description: string | null;
  amount: number;
  counterpartyAccountName: string | null;
  /** linked: undo would restore it. changed: the line moved on since the link (undo refuses). undone: undone. */
  state: TransferLinkState;
  undoneAt: string | null;
}

export type TransferLinkState = 'linked' | 'changed' | 'undone';


export interface TransferLinkBatch {
  batchId: string;
  source: TransferLinkSource;
  linkedAt: string;
  /** Links in the batch an undo would still restore (state 'linked'). */
  activeCount: number;
  links: TransferLinkItem[];
}

export function newLinkBatchId(): string {
  return crypto.randomUUID();
}

/** The column references the veto may correlate on. A closed set: no caller can splice a value in. */
type TxIdColumn = 'm.new_tx_id' | 'n.id' | 'bt_new.id';
type LineIdColumn = 'm.je_line_id' | 'jl.id' | 'sa.target_je_line_id';

/**
 * TRUE unless this (statement line, journal line) pair was linked and then
 * undone. An undone pair is never linked again, or the next page load would
 * redo what the user just undid; the line may still link to another journal
 * line or be allocated by hand. One `sql.unsafe`, interpolation only (see
 * journalInForceAsAt for why not a nested tagged template).
 */
export function pairNotUndoneFragment(txIdColumn: TxIdColumn, lineIdColumn: LineIdColumn, companyId: string) {
  return sql.unsafe(
    `NOT EXISTS (SELECT 1 FROM bank_transfer_link_log u
      WHERE u.company_id = $1::UUID AND u.bank_transaction_id = ${txIdColumn}
        AND u.journal_line_id = ${lineIdColumn} AND u.undone_at IS NOT NULL)`,
    [companyId],
  );
}

/**
 * TRUE when some statement line undid a link to this journal line. Only an ORDER BY tie-break: where the relink
 * offers one free leg per journal (DISTINCT ON), a leg vetoed for one line must not hide the journal's other leg
 * from it. With no undone link anywhere the order is exactly what it was.
 */
export function lineHasUndoneLinkFragment(lineIdColumn: 'jl_mine.id', companyId: string) {
  return sql.unsafe(
    `EXISTS (SELECT 1 FROM bank_transfer_link_log u
      WHERE u.company_id = $1::UUID AND u.journal_line_id = ${lineIdColumn} AND u.undone_at IS NOT NULL)`,
    [companyId],
  );
}

type Row = Record<string, unknown>;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

function dateOnly(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

/** Group log rows (newest first) into batches, keeping the row order inside each batch. */
export function groupTransferLinks(rows: Row[]): TransferLinkBatch[] {
  const byBatch = new Map<string, TransferLinkBatch>();
  for (const r of rows) {
    const batchId = String(r.link_batch_id);
    let batch = byBatch.get(batchId);
    if (!batch) {
      batch = {
        batchId,
        source: r.trigger_source === 'import' ? 'import' : 'page_load',
        linkedAt: iso(r.linked_at),
        activeCount: 0,
        links: [],
      };
      byBatch.set(batchId, batch);
    }
    const undoneAt = isoOrNull(r.undone_at);
    const state: TransferLinkState = undoneAt !== null ? 'undone' : r.still_linked === true ? 'linked' : 'changed';
    if (state === 'linked') batch.activeCount += 1;
    batch.links.push({
      id: String(r.id),
      bankTransactionId: String(r.bank_transaction_id),
      transactionDate: dateOnly(r.transaction_date),
      description: r.description === null || r.description === undefined ? null : String(r.description),
      amount: Number(r.amount),
      counterpartyAccountName: r.account_name === null || r.account_name === undefined ? null : String(r.account_name),
      state,
      undoneAt,
    });
  }
  return [...byBatch.values()];
}

/**
 * The last 90 days of automatic links on one bank account, newest first, grouped by batch: the latest
 * TRANSFER_LINK_MAX_BATCHES batches, each whole. A row is still linked only while its line is exactly what the link
 * left, the same test the undo applies (a Reverse or any later write leaves the log row without an undo stamp).
 */
export async function listTransferLinks(companyId: string, bankAccountId: string): Promise<TransferLinkBatch[]> {
  const rows = (await sql`
    WITH recent AS (
      SELECT link_batch_id, max(linked_at) AS batch_at
      FROM bank_transfer_link_log
      WHERE company_id = ${companyId}::UUID
        AND bank_account_id = ${bankAccountId}::UUID
        AND linked_at >= now() - INTERVAL '90 days'
      GROUP BY link_batch_id
      ORDER BY batch_at DESC, link_batch_id
      LIMIT ${TRANSFER_LINK_MAX_BATCHES}
    )
    SELECT l.id, l.link_batch_id, l.trigger_source, l.linked_at, l.undone_at, l.bank_transaction_id,
           bt.transaction_date, bt.description, bt.amount, ga.account_name,
           (l.undone_at IS NULL AND bt.updated_at = l.linked_row_updated_at
             AND bt.status = 'allocated' AND bt.allocation_type = 'transfer'
             AND bt.matched_journal_line_id = l.journal_line_id
             AND bt.transfer_journal_entry_id = l.journal_entry_id) IS TRUE AS still_linked
    FROM recent
    JOIN bank_transfer_link_log l ON l.link_batch_id = recent.link_batch_id AND l.company_id = ${companyId}::UUID
      AND l.bank_account_id = ${bankAccountId}::UUID
    JOIN bank_transactions bt ON bt.id = l.bank_transaction_id AND bt.company_id = ${companyId}::UUID
    LEFT JOIN gl_accounts ga ON ga.id = l.counterparty_account_id AND ga.company_id = ${companyId}::UUID
    ORDER BY recent.batch_at DESC, l.link_batch_id, bt.transaction_date, l.id
  `) as Row[];
  return groupTransferLinks(rows);
}
