/**
 * Credit Note Actions API
 * POST /api/accounting/credit-notes-action
 *   action: approve | cancel | apply
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { approveCreditNote, cancelCreditNote, applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteService';
import {
  CREDIT_NOTE_AUTO_APPLY,
  listCreditNoteAllocations,
} from '@/modules/accounting/services/shared/creditNoteFifo';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { ArPostingAfterWriteError } from '@/modules/accounting/services/ar/arErrors';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';

const CreditNoteActionSchema = z.discriminatedUnion('action', [
  // autoApply defaults to 'fifo' — approving a note applies its remainder to the
  // customer's open invoices oldest first. A form that wants the old
  // linked-document-only behaviour sends 'none'.
  z.object({
    action: z.literal('approve'),
    creditNoteId: UUID,
    autoApply: z.enum(CREDIT_NOTE_AUTO_APPLY).optional(),
  }),
  z.object({ action: z.literal('cancel'), creditNoteId: UUID, reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('apply'), creditNoteId: UUID, invoiceId: UUID }),
]);

/** The per-document application lines, in the shape the MCP tools report. */
async function applicationsOf(companyId: string, creditNoteId: string) {
  return (await listCreditNoteAllocations(companyId, creditNoteId))
    .map((l) => ({ invoice_id: l.invoiceId, amount: l.amount }));
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = CreditNoteActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  try {
    const userId = req.user.id;

    switch (parsed.data.action) {
      case 'approve': {
        const { creditNoteId, autoApply } = parsed.data;
        const creditNote = await withJournalDateRefusal(res, () => approveCreditNote(companyId, creditNoteId, userId, {
          autoApply: autoApply ?? 'fifo',
        }));
        if (creditNote === JOURNAL_DATE_REFUSED) return;
        // WHICH documents the money went to, not just how much moved. A note
        // linked to one invoice can settle entirely different ones — the link is
        // skipped when that document has posted nothing, and the FIFO walk
        // settles several — so a reply carrying only an amount and a status
        // tells the caller that a balance changed without saying whose.
        return apiResponse.success(res, {
          ...creditNote,
          applied_to_invoice_ids: await applicationsOf(companyId, creditNote.id),
        });
      }
      case 'cancel': {
        const { creditNoteId, reason } = parsed.data;
        const cancelled = await withJournalDateRefusal(res, () => cancelCreditNote(companyId, creditNoteId, userId, reason));
        if (cancelled === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, cancelled);
      }
      case 'apply': {
        const applied = await applyCreditNoteToInvoice(companyId, parsed.data.creditNoteId, parsed.data.invoiceId, userId);
        return apiResponse.success(res, {
          ...applied,
          applied_to_invoice_ids: await applicationsOf(companyId, applied.id),
        });
      }
    }
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    // R-035: a 409 the client acts on (submit for approval), not the blanket 400.
    if (respondIfApprovalRequired(res, err)) return;
    // Any row-lock timeout (D8 round 9: the reversal chain's head, a document row) is 503 + Retry-After.
    if (respondIfLockTimeout(res, err)) return;
    // After the journal was written: a 4xx would COMMIT the orphan draft. 5xx rolls it back.
    if (err instanceof ArPostingAfterWriteError) throw err;
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Credit note action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
