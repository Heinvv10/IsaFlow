/**
 * Credit-note CANCEL of a DRAFT — the void that posts nothing.
 *
 * A draft has no journal and no application, so cancelling it reverses nothing: it sets `status = 'cancelled'` and
 * stamps cancelled_by / cancelled_at / cancel_reason, exactly as the approved-note cancel stamps them, and touches no
 * other row. The number stays on the books (no gap in the series, which is why a draft numbered from the supplier
 * return sequence ends here and not in the hard delete), and no invoice or bill moves.
 *
 * Taken under the row lock approve and cancel take (`lockCreditNoteForUpdate`) with the status re-read inside it, so
 * a concurrent approve either holds the row first (this waits, then sees `approved` and refuses) or waits behind this
 * (and finds `cancelled`). The same guards as the draft delete run, from the same helper
 * (`assertNothingHoldsTheNote`): a "draft" that carries a journal, applied credit or an allocation row is corrupt
 * state and is refused, as is a note a dispute names or one with a pending approval request.
 *
 * Every refusal is raised BEFORE the one write, as a `CreditNoteDeleteRefusal`; the UPDATE is the only statement
 * that can change anything, so a refusal never leaves a partial write behind (the MCP tool relies on that).
 *
 * `cancelCreditNote` (creditNoteCancelService) hands a locked draft to `cancelLockedDraftCreditNote`; the approved
 * path there is unchanged.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { CreditNote } from '../../types/ar.types';
import { CreditNoteDeleteRefusal, assertNothingHoldsTheNote } from './creditNoteDeleteService';
import { lockCreditNoteForUpdate } from './creditNoteLock';
import { mapRow } from './creditNoteMapper';

/** The caller already holds the row lock and has read `cn` (status 'draft') under it. */
export async function cancelLockedDraftCreditNote(
  companyId: string, cn: DbRow, userId: string, reason?: string,
): Promise<CreditNote> {
  const id = String(cn.id);
  const number = String(cn.credit_note_number ?? id);
  if (String(cn.status) !== 'draft') {
    throw new CreditNoteDeleteRefusal('NOT_DRAFT', `Credit note ${number} is ${String(cn.status)}, not a draft: it changed after it was read. Read it again and retry.`);
  }
  await assertNothingHoldsTheNote(companyId, id, number, cn, 'cancel');

  // `status = 'draft'` again in the WHERE: the lock makes it redundant, and a surprise fails closed.
  const rows = (await sql`
    UPDATE credit_notes
    SET status = 'cancelled', cancelled_by = ${userId}::UUID, cancelled_at = NOW(), cancel_reason = ${reason || null}
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING *
  `) as DbRow[];
  if (rows.length !== 1) throw new Error(`Credit note ${id} vanished while being cancelled.`);
  log.info('Cancelled draft credit note', { id, number, reason }, 'accounting');
  return mapRow(rows[0]!);
}

/** Cancel a draft by id, for the callers that mean a draft only (the MCP tool): refuses any other status. */
export async function cancelDraftCreditNote(
  companyId: string, id: string, userId: string, reason?: string,
): Promise<CreditNote> {
  const cn = await lockCreditNoteForUpdate(companyId, id);
  if (!cn) throw new CreditNoteDeleteRefusal('NOT_FOUND', 'Not found');
  return cancelLockedDraftCreditNote(companyId, cn, userId, reason);
}
