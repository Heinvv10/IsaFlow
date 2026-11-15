/**
 * Admin Billing Invoice Mark Paid API
 * POST /api/admin/billing/invoices/[id]/mark-paid — Mark a sent/overdue invoice as paid (404 none; 409 any other status)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { markInvoicePaid } from '@/modules/admin/services/invoiceService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  payment_method: z.string().min(1).max(100),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const parsedId = UUID.safeParse(req.query.id);
    if (!parsedId.success) return apiResponse.badRequest(res, 'Invoice id must be a valid id');
    const id = parsedId.data;
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { payment_method } = parsed.data;
      const trimmed = payment_method.trim();

      // Nothing changed is an error, not a 200 with an audit row: a double click, or paying a draft.
      const outcome = await markInvoicePaid(id, trimmed);
      if (!outcome.ok && outcome.reason === 'not_found') return apiResponse.notFound(res, 'Invoice not found');
      if (!outcome.ok) {
        return apiResponse.conflict(res, `This invoice is ${outcome.status}; only a sent or overdue invoice can be marked paid`);
      }

      await logAdminAction(
        req.user.id,
        'invoice.mark_paid',
        'invoice',
        id,
        { payment_method: trimmed },
        getIp(req)
      );

      return apiResponse.success(res, { paid: true, payment_method: trimmed });
    } catch (err) {
      // A lock wait past its bound is a 503 + Retry-After; anything else is a 500 that rolls back (never a 400).
      if (respondIfLockTimeout(res, err)) return;
      log.error('Failed to mark invoice as paid', { id, error: err }, 'admin-api');
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
