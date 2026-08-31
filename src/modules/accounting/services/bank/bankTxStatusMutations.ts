/**
 * Bank transaction status mutations — match / unmatch / exclude.
 *
 * Split out of `bankTransactionQueryService` (which re-exports all three) so
 * that file stays under the 300-line limit once the locking guard landed.
 *
 * Each of these rewrites `status` and, for match/unmatch, `matched_journal_line_id`.
 * They used to do it with a bare UPDATE — no lock, no status predicate — so a
 * request that read the row as `imported` and then wrote could land on top of an
 * allocation another request had committed in between: the status went back to
 * `matched`/`imported`/`excluded`, the link to the posted journal was
 * overwritten or nulled, and that journal was left in the GL with nothing
 * pointing at it. Every one now takes the row lock first and refuses on a row
 * that carries a posted journal; undoing one of those is
 * `reverseReconciledTransaction`'s job, which posts the contra.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { BankTransaction } from '../../types/bank.types';
import { mapTxRow } from './bankTxRowMapper';
import { lockBankTransactionForUpdate } from './bankTxLock';

type Row = DbRow;

/**
 * The one status that means "an allocation posted a journal for this row".
 *
 * `reconciled` is deliberately NOT here. A reconciled row got there through
 * `matchTransaction` (bankReconciliationService only ever promotes rows whose
 * status is already `matched`), so its journal was written by something else
 * and pre-dates the link — unmatching it orphans nothing. The bank table still
 * offers Undo on reconciled rows, so refusing them would be a live 400 on a
 * button the UI shows.
 */
const POSTED_STATUS = 'allocated';

/**
 * Raised when a status mutation is asked to overwrite a row that carries a
 * posted journal. The bank API routes return a caught service error's message
 * as a 400, so this wording is what the caller reads.
 */
export class BankTransactionAllocatedError extends Error {
  readonly code = 'BANK_TX_ALLOCATED';
  constructor(bankTxId: string, status: string, verb: string) {
    super(
      `Bank transaction ${bankTxId} is ${status} with a posted journal — `
      + `reverse the allocation before you ${verb} it.`,
    );
    this.name = 'BankTransactionAllocatedError';
  }
}

/**
 * Lock the row, then refuse if it has already been allocated. `verb` is the
 * caller's own word for what it was about to do, so the message reads naturally.
 */
async function lockForStatusWrite(companyId: string, bankTxId: string, verb: string): Promise<Row> {
  const row = await lockBankTransactionForUpdate(companyId, bankTxId);
  if (!row) throw new Error(`Bank transaction ${bankTxId} not found`);
  const status = String(row.status ?? '');
  if (status === POSTED_STATUS && row.matched_journal_line_id) {
    throw new BankTransactionAllocatedError(bankTxId, status, verb);
  }
  return row;
}

export async function matchTransaction(
  companyId: string, bankTxId: string, journalLineId: string, reconciliationId?: string
): Promise<BankTransaction> {
  try {
    await lockForStatusWrite(companyId, bankTxId, 'match');
    let rows: Row[];
    if (reconciliationId) {
      rows = (await sql`
        UPDATE bank_transactions
        SET status = 'matched', matched_journal_line_id = ${journalLineId}::UUID,
            reconciliation_id = ${reconciliationId}::UUID
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID RETURNING *`) as Row[];
    } else {
      rows = (await sql`
        UPDATE bank_transactions
        SET status = 'matched', matched_journal_line_id = ${journalLineId}::UUID
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID RETURNING *`) as Row[];
    }
    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
    log.info('Matched bank transaction', { bankTxId, journalLineId }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to match bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

export async function unmatchTransaction(companyId: string, bankTxId: string): Promise<BankTransaction> {
  try {
    await lockForStatusWrite(companyId, bankTxId, 'unmatch');
    const rows = (await sql`
      UPDATE bank_transactions
      SET status = 'imported', matched_journal_line_id = NULL,
          allocation_type = NULL, allocated_entity_name = NULL,
          allocation_rule_id = NULL, allocation_rule_name = NULL
      WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID RETURNING *`) as Row[];
    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
    log.info('Unmatched bank transaction', { bankTxId }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to unmatch bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

export async function excludeTransaction(
  companyId: string, bankTxId: string, reason?: string
): Promise<BankTransaction> {
  try {
    await lockForStatusWrite(companyId, bankTxId, 'exclude');
    const rows = (await sql`
      UPDATE bank_transactions SET status = 'excluded', excluded_reason = ${reason || null}
      WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID RETURNING *`) as Row[];
    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
    log.info('Excluded bank transaction', { bankTxId, reason }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to exclude bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}
