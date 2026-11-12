/**
 * bankTransferLinkUndo: put statement lines back exactly as they were before an
 * automatic transfer link (migration 978, bank_transfer_link_log).
 *
 * The link posted nothing, so an undo is a pure field restore: the eight fields
 * the link overwrote go back to the values its log row recorded. Only a line
 * that is still exactly what the link left is restored: its `updated_at` must
 * equal the value recorded at link time (compared in SQL, a JS Date loses the
 * microseconds) and it must still be allocated as that transfer. Anything else
 * is refused, and the log row stays live.
 *
 * Lock order: the log rows are read unlocked, then the lines are locked in id
 * order (their sessions first, `lockBankTransactionsInIdOrder`), then one
 * guarded UPDATE re-checks `undone_at IS NULL`. Ties to no journal.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { logAuditOrThrow } from '../core/auditTrailService';

export type TransferLinkUndoErrorCode = 'NOT_FOUND' | 'CHANGED';

export class TransferLinkUndoError extends Error {
  readonly code: TransferLinkUndoErrorCode;
  constructor(code: TransferLinkUndoErrorCode, message: string) {
    super(message);
    this.name = 'TransferLinkUndoError';
    this.code = code;
  }
}

export interface TransferLinkUndoResult {
  undone: number;
  refused: number;
}

export type TransferLinkUndoTarget = { batchId: string } | { linkId: string };

export const UNDO_NOT_FOUND_MESSAGE = 'This transfer link was already undone, or does not exist.';
export const UNDO_CHANGED_LINE_MESSAGE = 'This line has changed since it was linked, so the link was not undone.';
export const UNDO_CHANGED_BATCH_MESSAGE = 'These lines have changed since they were linked, so nothing was undone.';

type Row = Record<string, unknown>;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export async function undoTransferLinks(
  companyId: string,
  target: TransferLinkUndoTarget,
  user: { id: string; email?: string },
): Promise<TransferLinkUndoResult> {
  const batchId = 'batchId' in target ? target.batchId : null;
  const linkId = 'linkId' in target ? target.linkId : null;
  const changedMessage = batchId ? UNDO_CHANGED_BATCH_MESSAGE : UNDO_CHANGED_LINE_MESSAGE;

  const active = (await sql`
    SELECT id, bank_transaction_id
    FROM bank_transfer_link_log
    WHERE company_id = ${companyId}::UUID
      AND undone_at IS NULL
      AND (link_batch_id = ${batchId}::UUID OR id = ${linkId}::UUID)
  `) as Row[];
  if (active.length === 0) throw new TransferLinkUndoError('NOT_FOUND', UNDO_NOT_FOUND_MESSAGE);

  const ids = active.map((r) => String(r.id));
  await lockBankTransactionsInIdOrder(companyId, active.map((r) => String(r.bank_transaction_id)));

  let restored: Row[];
  try {
    restored = await withSavepoint('transfer_link_undo', async () => (await sql`
      WITH restored AS (
        UPDATE bank_transactions bt
        SET status                    = l.prev_status,
            allocation_type           = l.prev_allocation_type,
            transfer_journal_entry_id = l.prev_transfer_journal_entry_id,
            matched_journal_line_id   = l.prev_matched_journal_line_id,
            counterparty_account_id   = l.prev_counterparty_account_id,
            allocated_entity_name     = l.prev_allocated_entity_name,
            allocation_rule_id        = l.prev_allocation_rule_id,
            allocation_rule_name      = l.prev_allocation_rule_name
        FROM bank_transfer_link_log l
        WHERE l.id = ANY(${ids}::UUID[]) AND l.company_id = ${companyId}::UUID AND l.undone_at IS NULL
          AND bt.id = l.bank_transaction_id AND bt.company_id = ${companyId}::UUID
          -- Nothing has written the line since the link.
          AND bt.updated_at = l.linked_row_updated_at
          AND bt.status = 'allocated' AND bt.allocation_type = 'transfer'
          AND bt.matched_journal_line_id = l.journal_line_id
          AND bt.transfer_journal_entry_id = l.journal_entry_id
        RETURNING l.id, bt.id AS bank_transaction_id, l.prev_status, l.prev_allocation_type, l.link_batch_id
      )
      UPDATE bank_transfer_link_log l SET undone_at = now()
      FROM restored r
      WHERE l.id = r.id AND l.company_id = ${companyId}::UUID
      RETURNING l.id, r.bank_transaction_id, r.prev_status, r.prev_allocation_type, r.link_batch_id
    `) as Row[]);
  } catch (err) {
    // A previous journal line another statement line has since claimed: the line cannot go back as it was.
    if (isUniqueViolation(err)) throw new TransferLinkUndoError('CHANGED', changedMessage);
    throw err;
  }

  if (restored.length === 0) throw new TransferLinkUndoError('CHANGED', changedMessage);

  // In the request transaction and throwing: an unrecorded undo does not commit.
  for (const r of restored) {
    await logAuditOrThrow({
      companyId,
      userId: user.id,
      userEmail: user.email,
      action: 'update',
      entityType: 'bank_transaction',
      entityId: String(r.bank_transaction_id),
      changes: {
        fields: [
          { field: 'status', old: 'allocated', new: r.prev_status === null ? null : String(r.prev_status), label: 'Status' },
          {
            field: 'allocation_type', old: 'transfer',
            new: r.prev_allocation_type === null ? null : String(r.prev_allocation_type), label: 'Allocation type',
          },
        ],
        metadata: { source: 'transfer_link_undo', linkBatchId: String(r.link_batch_id), linkId: String(r.id) },
      },
    });
  }

  const result = { undone: restored.length, refused: ids.length - restored.length };
  log.info('Undid automatic transfer links', { companyId, ...result }, 'accounting');
  return result;
}
