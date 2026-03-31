/**
 * Admin Billing Invoice Mark Paid API
 * POST /api/admin/billing/invoices/[id]/mark-paid — Mark an invoice as paid
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { markInvoicePaid } from '@/modules/admin/services/invoiceService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  if (req.method === 'POST') {
    try {
      const { payment_method } = req.body as { payment_method?: string };

      if (!payment_method || payment_method.trim().length === 0) {
        return apiResponse.badRequest(res, 'payment_method is required');
      }

      await markInvoicePaid(id, payment_method.trim());

      await logAdminAction(
        req.user.id,
        'invoice.mark_paid',
        'invoice',
        id,
        { payment_method: payment_method.trim() },
        getIp(req)
      );

      return apiResponse.success(res, { paid: true, payment_method: payment_method.trim() });
    } catch (err) {
      log.error('Failed to mark invoice as paid', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to mark invoice as paid');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
