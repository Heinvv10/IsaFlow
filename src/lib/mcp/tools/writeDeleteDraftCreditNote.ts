/**
 * MCP write tool: `delete_draft_credit_note` — remove a DRAFT credit note (customer or supplier) that never posted.
 *
 * The app has no draft-note delete, so this is a HARD delete (`ar/creditNoteDeleteService`, header there): the note
 * is locked FOR UPDATE, its status re-read inside the lock, and every refusal (not a draft, a journal or
 * applications on a "draft", a dispute pointing at it, a pending approval request) raised before the first write.
 * Posts nothing, so it needs `write:invoices` but not `write:post`. A deleted draft CANNOT be restored; `dry_run` is
 * the control, and it runs the real delete inside a savepoint that is always rolled back, so it meets every guard
 * (and the row lock) the live call meets.
 *
 * Only the typed refusal becomes a toolError: it is raised before any write. Anything else is rethrown so the
 * registry's savepoint unwinds the call.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA } from '@/lib/mcp/contracts';
import {
  CreditNoteDeleteRefusal,
  deleteDraftCreditNote,
  type DeletedCreditNote,
} from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { canDeleteDraftCreditNote } from '@/lib/auth/writeRoles';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'delete_draft_credit_note';

export const deleteDraftCreditNoteTool: McpTool = {
  name: TOOL,
  description:
    'Delete a DRAFT credit note (customer or supplier) that was never approved, e.g. a duplicate or a mistake. It has '
    + 'no journal, so nothing posts and no balance moves. Only a draft can be deleted: an approved, partially applied '
    + 'or applied note is refused and pointed to cancel_credit_note (needs write:post), and a cancelled note stays on '
    + 'the books. Also refused when the draft carries a journal or applied credit (inconsistent data), when a dispute '
    + 'resolution raised it, when it has a pending approval request, or when it was numbered from the supplier return '
    + 'sequence (a hard delete would leave a permanent gap in that series: leave it, or approve and cancel it). '
    + 'Owner or admin only. Attachments are detached (the files stay); nothing else is deleted. The delete is recorded '
    + 'in the audit trail. A deleted draft CANNOT be restored: the reply returns the note\'s values so create_credit_note '
    + 'can raise a fresh one (new id; a CN-year-number is issued as highest + 1, so deleting the latest frees its number). '
    + 'Run with dry_run first: it runs the real delete and rolls it '
    + 'back, so it refuses exactly what the live call would, and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string', description: 'The draft credit note, from list_credit_notes.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['credit_note_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // The registry's write fence admits owner/admin/manager; a hard delete is owner/admin only. Before anything is
    // read, and the dry run alike, so a manager is not shown a preview of a call that will be refused.
    if (!canDeleteDraftCreditNote(ctx.companyRole)) return toolError('Only an owner or admin can delete a draft credit note.');
    const id = strArg(args, 'credit_note_id');
    if (!id) return toolError('credit_note_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id'] });
    if (bad) return bad;

    try {
      if (args.dry_run === true) {
        let planned: DeletedCreditNote | null = null;
        await inRolledBackSavepoint('mcp_cn_delete_dry_run', async () => {
          planned = await deleteDraftCreditNote(ctx.companyId, id, ctx.userId);
        });
        // `wroteNothing` keeps the idempotency key free for the real call.
        return { ...ok({ dry_run: true, would_delete: shape(planned!), restorable: false }), wroteNothing: true };
      }
      const deleted = await deleteDraftCreditNote(ctx.companyId, id, ctx.userId);
      return ok({
        deleted: true,
        restorable: false,
        note: 'A deleted draft cannot be restored. To bring it back, call create_credit_note with these values: it gets a new id.',
        deleted_note: shape(deleted),
      });
    } catch (err) {
      // The same reply for a missing and a foreign id: the lock read is company-scoped, and distinct text would be
      // an existence oracle.
      if (err instanceof CreditNoteDeleteRefusal) return toolError(err.code === 'NOT_FOUND' ? NOT_FOUND : err.message);
      throw err;
    }
  },
};

function shape(n: DeletedCreditNote) {
  return {
    credit_note_id: n.id,
    credit_note_number: n.creditNoteNumber,
    type: n.type,
    status: 'draft',
    credit_date: n.creditDate,
    subtotal: n.subtotal,
    tax_rate: n.taxRate,
    tax_amount: n.taxAmount,
    total_amount: n.totalAmount,
    reason: n.reason,
    client_id: n.clientId,
    supplier_id: n.supplierId,
    customer_invoice_id: n.customerInvoiceId,
    supplier_invoice_id: n.supplierInvoiceId,
    gl_account_id: n.glAccountId,
    external_ref: n.externalRef,
    external_document_number: n.externalDocumentNumber,
    external_system: n.externalSystem,
    attachments_detached: n.attachmentsDetached,
  };
}
