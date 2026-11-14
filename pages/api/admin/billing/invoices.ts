/**
 * Admin Billing Invoices API
 * GET  /api/admin/billing/invoices — List invoices with filters
 * POST /api/admin/billing/invoices — Create an invoice
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { log } from '@/lib/logger';
import { listInvoices, createInvoice } from '@/modules/admin/services/invoiceService';
import { invoiceAmountsFromSubtotal } from '@/modules/admin/services/invoiceAmounts';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

// VAT and total are not accepted: createInvoice computes them from the subtotal (15%), so `.strict()` refuses a
// client-sent tax_cents / total_cents. A blank due date or notes may come as null or be left out.
const PostBody = z.object({
  company_id:      UUID,
  subscription_id: UUID.optional(),
  subtotal_cents:  z.number().int().nonnegative().max(1_800_000_000), // total (x1.15) must fit the INT column
  due_date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  line_items:      z.array(z.record(z.string(), z.unknown())).optional(),
  notes:           z.string().max(2000).nullable().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const { company_id, status, from_date, to_date, search, page, limit, sort_by, sort_dir } = req.query;

      const result = await listInvoices({
        company_id: company_id as string | undefined,
        status: status as string | undefined,
        from_date: from_date as string | undefined,
        to_date: to_date as string | undefined,
        search: search as string | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        sort_by: sort_by as string | undefined,
        sort_dir: sort_dir === 'asc' || sort_dir === 'desc' ? sort_dir : undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to list invoices', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list invoices');
    }
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { company_id, subscription_id, subtotal_cents, due_date, line_items, notes } = parsed.data;

      const invoiceId = await createInvoice({ company_id, subscription_id, subtotal_cents, due_date, line_items, notes });

      await logAdminAction(
        req.user.id,
        'invoice.create',
        'invoice',
        invoiceId,
        { company_id, subscription_id, ...invoiceAmountsFromSubtotal(subtotal_cents) },
        getIp(req)
      );

      return apiResponse.success(res, { id: invoiceId });
    } catch (err) {
      // The invoice-number lock held past its 5 s bound: 503 + Retry-After, never the 400 below.
      if (respondIfLockTimeout(res, err)) return;
      log.error('Failed to create invoice', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to create invoice');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(withCsrf(handler));
