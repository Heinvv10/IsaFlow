/**
 * Credit-note CANCEL of a DRAFT — the void that posts nothing.
 *
 * A draft has no journal and no application, so cancelling it reverses nothing: it sets `status = 'cancelled'` and
 * stamps cancelled_by / cancelled_at / cancel_reason, exactly as the approved-note cancel stamps them, and touches no
 * other credit-note row. The number stays on the books (no gap in the series, which is why a draft numbered from the
 * supplier return sequence ends here and not in the hard delete), and no invoice or bill moves.
 *
 * DRAFT-ONLY by construction. The generic `cancelCreditNote` (creditNoteCancelService) still refuses a draft and
 * reverses a posted note; this is a separate entry point (the app's `cancel_draft` action and the MCP tool's draft
 * branch), so a person who clicked "Cancel draft" on a note that was approved meanwhile gets a refusal, never the
 * reversal of a posted journal. The status is read under the row lock (`lockCreditNoteForUpdate`) and a concurrent
 * approve either holds the row first (this waits, then sees `approved` and refuses) or waits behind this (and finds
 * `cancelled`). Raising an approval request takes the same row FOR SHARE (`shareLockCreditNoteDraft`), so one cannot
 * appear between the pending check below and the UPDATE.
 *
 * The same guards as the draft delete run, from the same helper (`assertNothingHoldsTheNote`): a "draft" that
 * carries a journal, applied credit or an allocation row is corrupt state and is refused, as is a note a dispute
 * names or one with a pending approval request. Every refusal is raised BEFORE the one write, as a
 * `CreditNoteDeleteRefusal` (the MCP tool relies on that).
 *
 * WHO: `cancelled_by` is the user. credit_notes.actor_type / actor_token_jti already hold the CREATOR's identity
 * (migration 531) and are not overwritten, so an agent cancel is recorded in an audit_log row written in the same
 * transaction (action 'update', status draft -> cancelled, metadata: the posting agent, actor type and token jti).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { CreditNote } from '../../types/ar.types';
import { logAuditOrThrow } from '../core/auditTrailService';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import { CreditNoteDeleteRefusal, assertNothingHoldsTheNote } from './creditNoteDeleteService';
import { lockCreditNoteForUpdate } from './creditNoteLock';
import { mapRow } from './creditNoteMapper';

export async function cancelDraftCreditNote(
  companyId: string, id: string, userId: string, reason?: string, opts?: PostingActorOpts,
): Promise<CreditNote> {
  const cn = await lockCreditNoteForUpdate(companyId, id);
  if (!cn) throw new CreditNoteDeleteRefusal('NOT_FOUND', 'Not found');
  const number = String(cn.credit_note_number ?? id);
  const status = String(cn.status);
  if (status !== 'draft') {
    throw new CreditNoteDeleteRefusal('NOT_DRAFT',
      `Credit note ${number} is ${status}, not a draft, so it was not cancelled as one. `
      + (status === 'cancelled' ? 'It is already cancelled.' : 'Read it again: a posted note is reversed with cancel_credit_note, which needs the write:post permission.'));
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

  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'credit_note', entityId: id, entityRef: number,
    changes: {
      fields: [
        { field: 'status', old: 'draft', new: 'cancelled', label: 'status' },
        ...(reason ? [{ field: 'cancel_reason', old: null, new: reason, label: 'cancel_reason' }] : []),
      ],
      metadata: {
        source: opts?.postingAgent ?? 'cancel_draft_credit_note',
        ...(opts?.actorType ? { actor_type: opts.actorType } : {}),
        ...(opts?.actorTokenJti ? { actor_token_jti: opts.actorTokenJti } : {}),
      },
    },
  });
  log.info('Cancelled draft credit note', { id, number, reason }, 'accounting');
  return mapRow(rows[0]!);
}
