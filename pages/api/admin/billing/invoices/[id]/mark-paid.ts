/**
 * Admin Billing Invoice Mark Paid API
 * POST /api/admin/billing/invoices/[id]/mark-paid — Mark an invoice as paid
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { markInvoicePaid } from '@/modules/admin/services/invoiceService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  payment_method: z.string().min(1).max(100),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { payment_method } = parsed.data;
      const trimmed = payment_method.trim();

      await markInvoicePaid(id, trimmed);

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
      log.error('Failed to mark invoice as paid', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to mark invoice as paid');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
