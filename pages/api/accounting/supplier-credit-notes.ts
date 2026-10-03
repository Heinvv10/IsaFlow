/**
 * Supplier Credit Notes API
 * GET  /api/accounting/supplier-credit-notes          - List supplier credit notes
 * GET  /api/accounting/supplier-credit-notes?id=UUID  - Get one supplier credit note
 * POST /api/accounting/supplier-credit-notes          - Create draft supplier credit note
 * PATCH /api/accounting/supplier-credit-notes         - Update status (post / reverse)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import {
  getCreditNotes,
  getCreditNoteById,
  createCreditNote,
  approveCreditNote,
  cancelCreditNote,
} from '@/modules/accounting/services/ar/creditNoteService';
import type { CreditNoteStatus } from '@/modules/accounting/types/ar.types';
import {
  CREDIT_NOTE_AUTO_APPLY,
  listCreditNoteAllocations,
  parseCreditNoteAutoApply,
} from '@/modules/accounting/services/shared/creditNoteFifo';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { ReversalBeforeOriginalError } from '@/modules/accounting/services/gl/journalEntryReversalDate';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = req.user.id;

  // ─── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { id, status, limit, offset } = req.query;
      if (id) {
        const note = await getCreditNoteById(companyId, id as string);
        if (!note) return apiResponse.notFound(res, 'Supplier Credit Note', id as string);
        if (note.type !== 'supplier') return apiResponse.notFound(res, 'Supplier Credit Note', id as string);
        return apiResponse.success(res, note);
      }
      const result = await getCreditNotes(companyId, {
        type: 'supplier',
        status: status as CreditNoteStatus | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('supplier-credit-notes GET failed', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to get supplier credit notes');
    }
  }

  // ─── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const {
        supplierId, supplierInvoiceId, creditDate, reference,
        description, lineItems, submitAction,
      } = req.body as {
        supplierId?: string;
        supplierInvoiceId?: string;
        creditDate?: string;
        reference?: string;
        description?: string;
        lineItems?: Array<{ description: string; quantity: number; unitPrice: number; vatType: string }>;
        notes?: string;
        submitAction?: 'draft' | 'post';
      };

      // R-032 L5: create-and-post is a posting; refuse it before the draft is written.
      if (submitAction === 'post') await assertNotImpersonating();
      if (!supplierId) return apiResponse.badRequest(res, 'supplierId is required');
      if (!creditDate) return apiResponse.badRequest(res, 'creditDate is required');
      if (!lineItems || lineItems.length === 0) return apiResponse.badRequest(res, 'At least one line item is required');

      // W1 family (P2.1): negative/zero lines invert the CN's GL at approve.
      for (const li of lineItems) {
        if (!(Number(li.quantity) > 0)) {
          return apiResponse.badRequest(res, 'Line quantities must be positive');
        }
        if (Number(li.unitPrice) < 0) {
          return apiResponse.badRequest(res, 'Line unit prices cannot be negative');
        }
      }

      // Calculate totals from line items
      const subtotal = lineItems.reduce((sum, li) => {
        return sum + li.quantity * li.unitPrice;
      }, 0);

      // Standard 15% VAT — line items carry vatType for future per-line VAT
      const taxRate = 15;

      const note = await createCreditNote(companyId, {
        type: 'supplier',
        supplierId,
        supplierInvoiceId: supplierInvoiceId || undefined,
        creditDate,
        reason: description || reference || undefined,
        subtotal: Math.round(subtotal * 100) / 100,
        taxRate,
        projectId: undefined,
      }, userId);

      // Auto-post if requested
      if (submitAction === 'post') {
        const posted = await approveCreditNote(companyId, note.id, userId, { autoApply: 'fifo' });
        log.info('Supplier credit note created and posted', { id: posted.id }, 'accounting-api');
        // The bills this note actually settled — see the same note in
        // credit-notes-action: the link does not say where the money went.
        return apiResponse.created(res, {
          ...posted,
          applied_to_invoice_ids: (await listCreditNoteAllocations(companyId, posted.id))
            .map((l) => ({ invoice_id: l.invoiceId, amount: l.amount })),
        });
      }

      log.info('Supplier credit note created as draft', { id: note.id }, 'accounting-api');
      return apiResponse.created(res, note);
    } catch (err) {
      if (respondIfImpersonationForbidden(res, err)) return;
      log.error('supplier-credit-notes POST failed', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to create supplier credit note');
    }
  }

  // ─── PATCH ────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const { id, action, autoApply } = req.body as { id?: string; action?: string; autoApply?: string };
      // Refused rather than coerced: a caller that meant to keep the credit on
      // account must not have it spent by a typo. See creditNoteFifo.
      const parsedAutoApply = autoApply === undefined ? 'fifo' as const : parseCreditNoteAutoApply(autoApply);
      if (parsedAutoApply === null) {
        return apiResponse.badRequest(res, `autoApply must be one of: ${CREDIT_NOTE_AUTO_APPLY.join(', ')}`);
      }
      if (!id) return apiResponse.badRequest(res, 'id is required');
      if (!action) return apiResponse.badRequest(res, 'action is required');

      const existing = await getCreditNoteById(companyId, id);
      if (!existing) return apiResponse.notFound(res, 'Supplier Credit Note', id);
      if (existing.type !== 'supplier') return apiResponse.notFound(res, 'Supplier Credit Note', id);

      if (action === 'post') {
        const posted = await approveCreditNote(companyId, id, userId, { autoApply: parsedAutoApply });
        return apiResponse.success(res, {
          ...posted,
          applied_to_invoice_ids: (await listCreditNoteAllocations(companyId, posted.id))
            .map((l) => ({ invoice_id: l.invoiceId, amount: l.amount })),
        });
      }

      if (action === 'reverse') {
        const reversed = await cancelCreditNote(companyId, id, userId);
        return apiResponse.success(res, reversed);
      }

      return apiResponse.badRequest(res, `Unknown action: ${action}. Valid: post, reverse`);
    } catch (err) {
      // 'reverse' (cancelCreditNote): the refusal comes from dating the
      // reversal (resolveReversalDateDetailed) BEFORE reverseJournalEntry
      // claims anything, and the cancel's only earlier statements are the
      // credit-note row lock and reads — so this 4xx commits nothing. 'post'
      // (approveCreditNote) refuses in createJournalEntry before its draft,
      // after only reads of the note.
      if (respondIfImpersonationForbidden(res, err)) return;
      if (err instanceof VatPeriodLockedError || err instanceof ReversalBeforeOriginalError) {
        return apiResponse.badRequest(res, err.message);
      }
      // 'reverse' runs under the credit-note cancel's flow lock budget (D8 round 10): 503 + Retry-After.
      if (respondIfLockTimeout(res, err)) return;
      log.error('supplier-credit-notes PATCH failed', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to update supplier credit note');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
