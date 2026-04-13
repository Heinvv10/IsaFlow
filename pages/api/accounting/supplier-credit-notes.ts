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
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getCreditNotes,
  getCreditNoteById,
  createCreditNote,
  approveCreditNote,
  cancelCreditNote,
} from '@/modules/accounting/services/ar/creditNoteService';
import type { CreditNoteStatus } from '@/modules/accounting/types/ar.types';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
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
        description, lineItems, notes, submitAction,
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

      if (!supplierId) return apiResponse.badRequest(res, 'supplierId is required');
      if (!creditDate) return apiResponse.badRequest(res, 'creditDate is required');
      if (!lineItems || lineItems.length === 0) return apiResponse.badRequest(res, 'At least one line item is required');

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
        const posted = await approveCreditNote(companyId, note.id, userId);
        log.info('Supplier credit note created and posted', { id: posted.id }, 'accounting-api');
        return apiResponse.created(res, posted);
      }

      log.info('Supplier credit note created as draft', { id: note.id }, 'accounting-api');
      return apiResponse.created(res, note);
    } catch (err) {
      log.error('supplier-credit-notes POST failed', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to create supplier credit note');
    }
  }

  // ─── PATCH ────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const { id, action } = req.body as { id?: string; action?: string };
      if (!id) return apiResponse.badRequest(res, 'id is required');
      if (!action) return apiResponse.badRequest(res, 'action is required');

      const existing = await getCreditNoteById(companyId, id);
      if (!existing) return apiResponse.notFound(res, 'Supplier Credit Note', id);
      if (existing.type !== 'supplier') return apiResponse.notFound(res, 'Supplier Credit Note', id);

      if (action === 'post') {
        const posted = await approveCreditNote(companyId, id, userId);
        return apiResponse.success(res, posted);
      }

      if (action === 'reverse') {
        const reversed = await cancelCreditNote(companyId, id, userId);
        return apiResponse.success(res, reversed);
      }

      return apiResponse.badRequest(res, `Unknown action: ${action}. Valid: post, reverse`);
    } catch (err) {
      log.error('supplier-credit-notes PATCH failed', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to update supplier credit note');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH']);
}

export default withCompany(withErrorHandler(withWriteAccess(handler as never)));
