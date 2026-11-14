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
import { invoiceAmountsFromSubtotal, MAX_INVOICE_SUBTOTAL_CENTS } from '@/modules/admin/services/invoiceAmounts';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

/** A real calendar day: 2026-02-31 matches the pattern but is not one. */
const isRealIsoDate = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// VAT and total are not accepted: createInvoice computes them from the subtotal (15%), so `.strict()` refuses a
// client-sent tax_cents / total_cents. A blank due date or notes may come as null or be left out; blank notes
// are stored as NULL.
const PostBody = z.object({
  company_id:      UUID,
  subscription_id: UUID.optional(),
  subtotal_cents:  z.number().int().nonnegative()
    .max(MAX_INVOICE_SUBTOTAL_CENTS, `subtotal_cents may be at most ${MAX_INVOICE_SUBTOTAL_CENTS} (the total must fit the invoice columns)`),
  due_date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD')
    .refine(isRealIsoDate, 'due_date is not a real date').nullable().optional(),
  line_items:      z.array(z.record(z.string(), z.unknown())).optional(),
  notes:           z.string().max(2000).nullable().optional()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim())),
}).strict();

/** The first problem, named by its field: "due_date: due_date is not a real date", "Unrecognized key: total_cents". */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid input';
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

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
      return apiResponse.badRequest(res, firstIssue(parsed.error));
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
      // The invoice-number lock held past its 5 s bound: 503 + Retry-After.
      if (respondIfLockTimeout(res, err)) return;
      // A company or subscription id that does not exist is the caller's mistake; anything else is a 500.
      if ((err as { code?: string } | null)?.code === '23503') {
        return apiResponse.badRequest(res, 'No such company or subscription');
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(withCsrf(handler));
