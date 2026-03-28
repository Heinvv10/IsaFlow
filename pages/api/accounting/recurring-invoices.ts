/**
 * Recurring Invoices API
 * GET  — list recurring invoices
 * POST — create recurring invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  getRecurringInvoices,
  createRecurringInvoice,
} from '@/modules/accounting/services/recurringInvoiceService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { status, clientId, limit, offset } = req.query;
    const result = await getRecurringInvoices(companyId, {
      status: status as string,
      clientId: clientId as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;
    try {
      const item = await createRecurringInvoice(companyId, req.body, userId);
      return apiResponse.success(res, item);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Recurring invoice create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'PUT') {
    const { id, templateName, frequency, nextRunDate, description, lineItems } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      let subtotal = 0;
      if (lineItems) {
        for (const l of lineItems) subtotal += (l.quantity || 1) * (l.unitPrice || 0);
      }
      const taxAmount = Math.round(subtotal * 0.15 * 100) / 100;
      await sql`
        UPDATE recurring_invoices SET
          template_name = COALESCE(${templateName || null}, template_name),
          frequency = COALESCE(${frequency || null}, frequency),
          next_run_date = COALESCE(${nextRunDate || null}, next_run_date),
          description = COALESCE(${description || null}, description),
          line_items = COALESCE(${lineItems ? JSON.stringify(lineItems) : null}::JSONB, line_items),
          subtotal = CASE WHEN ${lineItems ? 'true' : 'false'} = 'true' THEN ${subtotal} ELSE subtotal END,
          tax_amount = CASE WHEN ${lineItems ? 'true' : 'false'} = 'true' THEN ${taxAmount} ELSE tax_amount END,
          total_amount = CASE WHEN ${lineItems ? 'true' : 'false'} = 'true' THEN ${subtotal + taxAmount} ELSE total_amount END,
          updated_at = NOW()
        WHERE id = ${id}::UUID AND company_id = ${companyId} AND status IN ('active', 'paused')
      `;
      log.info('Recurring invoice updated', { id });
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      log.error('Recurring invoice update failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Update failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
