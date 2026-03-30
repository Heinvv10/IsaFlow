/**
 * Admin Billing Invoices API
 * GET  /api/admin/billing/invoices — List invoices with filters
 * POST /api/admin/billing/invoices — Create an invoice
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listInvoices, createInvoice } from '@/modules/admin/services/invoiceService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const { company_id, status, from_date, to_date, search, page, limit } = req.query;

      const result = await listInvoices({
        company_id: company_id as string | undefined,
        status: status as string | undefined,
        from_date: from_date as string | undefined,
        to_date: to_date as string | undefined,
        search: search as string | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to list invoices', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list invoices');
    }
  }

  if (req.method === 'POST') {
    try {
      const {
        company_id,
        subscription_id,
        subtotal_cents,
        tax_cents,
        total_cents,
        due_date,
        line_items,
        notes,
      } = req.body as {
        company_id: string;
        subscription_id?: string;
        subtotal_cents: number;
        tax_cents: number;
        total_cents: number;
        due_date?: string;
        line_items?: Record<string, unknown>[];
        notes?: string;
      };

      if (!company_id || subtotal_cents == null || total_cents == null) {
        return apiResponse.badRequest(res, 'company_id, subtotal_cents, and total_cents are required');
      }

      const invoiceId = await createInvoice({
        company_id,
        subscription_id,
        subtotal_cents,
        tax_cents: tax_cents ?? 0,
        total_cents,
        due_date,
        line_items,
        notes,
      });

      await logAdminAction(
        req.user.id,
        'invoice.create',
        'invoice',
        invoiceId,
        { company_id, subscription_id, total_cents },
        getIp(req)
      );

      return apiResponse.success(res, { id: invoiceId });
    } catch (err) {
      log.error('Failed to create invoice', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to create invoice');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
