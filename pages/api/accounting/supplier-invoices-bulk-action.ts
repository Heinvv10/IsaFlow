/**
 * Supplier Invoice Bulk Actions API
 * POST /api/accounting/supplier-invoices-bulk-action
 *   { action: 'approve' | 'cancel' | 'post_gl', invoiceIds: UUID[] }
 *
 * Runs each per-id action sequentially and reports outcome per id. Each
 * action wraps its own DB transaction inside the workflow service; we
 * intentionally do NOT wrap the entire batch in one tx because individual
 * approve/post-GL flows already manage their own atomicity (creating JEs,
 * stamping audit fields), and a failed row should not roll back successful
 * sibling rows in the same batch.
 *
 * Replaces the previous client-side fan-out (N parallel POSTs to
 * supplier-invoices-action) which had no atomicity story and provided no
 * per-id failure reporting.
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
  withWriteAccess,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  approveSupplierInvoice,
  cancelSupplierInvoice,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

const Schema = z.object({
  action: z.enum(['approve', 'cancel', 'post_gl']),
  invoiceIds: z.array(UUID).min(1).max(200),
});

interface ItemResult {
  invoiceId: string;
  ok: boolean;
  error?: string;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(
      res,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const { action, invoiceIds } = parsed.data;
  const userId = req.user.id;
  const results: ItemResult[] = [];

  // Sorted, NOT the order the client sent. Every action below now takes a row
  // lock (approve via lockSupplierInvoiceForUpdate, cancel via its own
  // FOR UPDATE) and holds it to the end of this request's single transaction.
  // Two overlapping batches that walk the same rows in opposite orders deadlock
  // on each other (40P01) — this route with the grid's selection order, and
  // `bulk_approve_supplier_invoices`, which sorts for exactly this reason. A
  // total order over the locked rows makes that impossible: the batch that gets
  // there first simply blocks the other. Sorting also cannot change the outcome,
  // since each id is processed independently and reported by id.
  const ordered = [...invoiceIds].sort();

  for (const invoiceId of ordered) {
    try {
      switch (action) {
        case 'approve':
          await approveSupplierInvoice(companyId, invoiceId, userId);
          break;
        case 'cancel':
          await cancelSupplierInvoice(companyId, invoiceId, userId);
          break;
        case 'post_gl':
          await postSupplierInvoiceToGL(companyId, invoiceId, userId);
          break;
      }
      results.push({ invoiceId, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      log.warn('Bulk supplier invoice action failed for one id', {
        action, invoiceId, error: message,
      }, 'accounting-api');
      results.push({ invoiceId, ok: false, error: message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  return apiResponse.success(res, {
    action,
    total: results.length,
    succeeded,
    failed,
    results,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
