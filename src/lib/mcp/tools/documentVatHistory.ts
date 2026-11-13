/**
 * MCP read tool: document_vat_history (brief step 5a, 2026-11-13) — every VAT line tied to one bill,
 * customer invoice or credit note, and the VAT it carries NOW. A wrap of
 * reports/documentVatHistory.getDocumentVatHistory; its header says what each tie means.
 *
 * Scope: `read:vat` (what every vat_* read needs) AND `read:invoices` (what reading the document itself
 * needs — list_credit_notes, get_supplier_invoice). Free, like every read.
 */
import type { McpTool } from '../types';
import {
  DOCUMENT_VAT_ENTITY_TYPES, getDocumentVatHistory, type DocumentVatEntityType,
} from '@/modules/accounting/services/reports/documentVatHistory';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const documentVatHistoryTool: McpTool = {
  name: 'document_vat_history',
  description:
    'EVERY VAT LINE TIED TO ONE DOCUMENT, AND THE VAT IT CARRIES NOW. entity_type supplier_invoice, customer_invoice or '
    + 'credit_note; entity_id from list_supplier_invoices / list_invoices / list_credit_notes. One row per VAT line (journal '
    + 'id, number, date, source, status, reversed, GL account, vat_type, vat_amount signed in the document\'s own direction — '
    + 'positive = the way its posting moved VAT — and net_base where derivable) with tie: posting (its own journal), '
    + 'late_claim (its s16(3) late-claim companion), reversal (the posting\'s reversal chain), credit_note (a LINKED note\'s '
    + 'journal and its cancel), and the HEURISTIC reference_match / narration_match: a posted journal that is no document\'s '
    + 'own posting (bank allocations, hand journals, imports, write-offs… — not invoice, bill, credit-note, payment or payroll '
    + 'postings), dated in or after the document\'s fiscal period, with a line on one of its own VAT accounts, whose reference '
    + 'or narration names its number as a whole token; only its lines on those accounts count. Totals: vat_posted, '
    + 'vat_derivable_now (what the posting, companion, reversals and credit notes leave), vat_heuristic, '
    + 'vat_heuristic_reducing, vat_net_now (derivable plus each match\'s NEGATIVE net — a match that adds VAT never offsets '
    + 'one that took it away), vat_reversed, vat_by_tie, net_base_posted, net_base_now; heuristic.matches lists each match '
    + 'with its chain\'s net. heuristic.searched says '
    + 'whether a search ran; notes explains gaps (a cancelled document no longer names its posting). Check heuristic matches '
    + 'before relying on them. Only posted journals count, as the VAT201 reads them, future-dated ones included. Use before '
    + 'crediting a bill (create_credit_note mirror_bill reads the same figures) to avoid reversing its VAT twice.',
  scope: 'read:vat',
  requiresScope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      entity_type: { type: 'string', enum: [...DOCUMENT_VAT_ENTITY_TYPES] },
      entity_id: { type: 'string', description: 'The document\'s UUID.' },
    },
    required: ['entity_type', 'entity_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const entityType = strArg(args, 'entity_type');
    if (!entityType || !(DOCUMENT_VAT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      return toolError(`entity_type must be one of: ${DOCUMENT_VAT_ENTITY_TYPES.join(', ')}`);
    }
    if (!strArg(args, 'entity_id')) return toolError('entity_id is required');
    const bad = guardCastableArgs(args, { uuid: ['entity_id'] });
    if (bad) return bad;
    const history = await getDocumentVatHistory(ctx.companyId, entityType as DocumentVatEntityType, strArg(args, 'entity_id')!);
    if (!history) return toolError(NOT_FOUND);
    return ok(history);
  },
};
