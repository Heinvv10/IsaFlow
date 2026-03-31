/**
 * Admin Billing Invoice Send API
 * POST /api/admin/billing/invoices/[id]/send — Send an invoice to the customer
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sendInvoice } from '@/modules/admin/services/invoiceService';
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
      await sendInvoice(id);

      await logAdminAction(
        req.user.id,
        'invoice.send',
        'invoice',
        id,
        null,
        getIp(req)
      );

      return apiResponse.success(res, { sent: true });
    } catch (err) {
      log.error('Failed to send invoice', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to send invoice');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
