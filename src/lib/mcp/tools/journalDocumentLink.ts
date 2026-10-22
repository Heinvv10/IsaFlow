/**
 * link_document_to_journal — VAT-gaps batch item 1 (migration 706,
 * gl/journalDocumentLinkService). Links (or unlinks) a captured document to a
 * POSTED, unreversed journal that cannot carry `source_document_id` — manual,
 * recurring, Sage-GL-import and migration journals claiming input VAT with no
 * evidence attached. A linked document clears `unsupportedInputVat` for that
 * journal (vat_status / vat_exceptions); unlinking restores the block.
 *
 * No extra role — same write permission as any other journal edit.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, actorForMcp } from '../contracts';
import {
  linkDocumentToJournal, unlinkDocumentFromJournal, JournalDocumentLinkRefusal,
} from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const linkDocumentToJournalTool: McpTool = {
  name: 'link_document_to_journal',
  description:
    'Links (action:"link") or unlinks (action:"unlink") a captured document to a POSTED, unreversed journal entry of this company, for a journal that has no other way to carry evidence — manual, recurring, Sage-GL-import and migration journals never get source_document_id. '
    + 'A linked document is read by vat_status / vat_exceptions the same way a created-from-capture journal is: it clears that journal from the blocking "unsupported input VAT" list. Unlinking restores the block. '
    + 'ONE DOCUMENT, ONE CLAIM: a document already backing a posted journal (via source_document_id or another active link) cannot be linked again — unlink it first, or use a different document. '
    + 'reason is required for both link and unlink, and every call is audit-logged. '
    + 'RUN dry_run FIRST — it validates the journal and document without writing anything.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['link', 'unlink'] },
      journal_entry_id: { type: 'string' },
      captured_document_id: { type: 'string' },
      reason: { type: 'string', description: 'Required for both link and unlink.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['action', 'journal_entry_id', 'captured_document_id', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const action = args.action === 'unlink' ? 'unlink' : args.action === 'link' ? 'link' : null;
    if (!action) return toolError('action must be "link" or "unlink"');

    const journalEntryId = strArg(args, 'journal_entry_id');
    const capturedDocumentId = strArg(args, 'captured_document_id');
    if (!journalEntryId || !capturedDocumentId) {
      return toolError('journal_entry_id and captured_document_id are required');
    }
    const bad = guardCastableArgs(args, { uuid: ['journal_entry_id', 'captured_document_id'] });
    if (bad) return bad;
    const reason = strArg(args, 'reason');
    if (!reason) return toolError('reason is required');

    const actor = actorForMcp(ctx, `mcp:link_document_to_journal:v1`);

    if (args.dry_run === true) {
      return {
        ...ok({ dryRun: true, action, journalEntryId, capturedDocumentId }),
        wroteNothing: true,
      };
    }

    // Every refusal here is PRE-write (loadLinkableJournal / loadCompanyDocument
    // / assertDocumentNotAlreadyPosted all run before the INSERT/UPDATE), so a
    // toolError is safe on the first — and only — write attempt this call makes.
    try {
      if (action === 'link') {
        const link = await linkDocumentToJournal(ctx.companyId, journalEntryId, capturedDocumentId, actor.userId, reason);
        return ok({ action, link });
      }
      await unlinkDocumentFromJournal(ctx.companyId, journalEntryId, capturedDocumentId, actor.userId, reason);
      return ok({ action, journalEntryId, capturedDocumentId, unlinked: true });
    } catch (err) {
      if (err instanceof JournalDocumentLinkRefusal) return toolError(err.message);
      throw err;
    }
  },
};
