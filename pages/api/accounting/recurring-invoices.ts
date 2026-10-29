/**
 * Recurring Invoices API
 * GET  — list recurring invoices
 * POST — create recurring invoice
 * PUT  — edit a recurring invoice (End Date; edits keep the stored tax rate)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  editTotals,
  parseEndDateEdit,
  RecurringInvoiceEditError,
  resolveEditTaxRate,
} from '@/modules/accounting/services/ar/recurringInvoiceEdit';
import { lockRecurringTemplate } from '@/modules/accounting/services/ar/recurringInvoiceLock';
import {
  getRecurringInvoices,
  createRecurringInvoice,
} from '@/modules/accounting/services/ar/recurringInvoiceService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

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
      if (respondIfLockTimeout(res, err)) return;
      log.error('Recurring invoice create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  if (req.method === 'PUT') {
    const { id, templateName, frequency, nextRunDate, description, lineItems } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      const endDate = parseEndDateEdit(req.body);
      if (req.body.taxRate != null && !lineItems) {
        return apiResponse.badRequest(res, 'taxRate can only be changed together with lineItems');
      }
      // Row-locked read of the stored template: the tax basis an edit without
      // taxRate keeps is its stored tax_rate, and nothing may change it between
      // this read and the UPDATE.
      const stored = await lockRecurringTemplate(companyId, id);
      if (!stored) return apiResponse.notFound(res, 'Recurring invoice', id);
      if (lineItems) {
        // W1 family (P2.1): an edited template with negative lines re-mints a
        // negative APPROVED invoice every period — same guard as create.
        for (const l of lineItems) {
          if (!(Number(l.quantity ?? 1) > 0)) {
            return apiResponse.badRequest(res, 'Line quantities must be positive');
          }
          if (!(Number(l.unitPrice ?? 0) >= 0)) {
            return apiResponse.badRequest(res, 'Line unit prices cannot be negative');
          }
        }
      }
      const taxRate = resolveEditTaxRate(req.body.taxRate, stored.tax_rate);
      const { subtotal, taxAmount, totalAmount } = editTotals(lineItems ?? [], taxRate);
      const lines = lineItems ? JSON.stringify(lineItems) : null;
      // R-035 PR4 review F1: an edit that changes what the template bills makes
      // the editor an author of every invoice it mints from now on.
      await sql`
        UPDATE recurring_invoices SET
          content_authors = CASE WHEN ${lines}::JSONB IS NOT NULL
              AND (line_items, subtotal, tax_amount, total_amount) IS DISTINCT FROM
                  (${lines}::JSONB, ${subtotal}::NUMERIC, ${taxAmount}::NUMERIC, ${totalAmount}::NUMERIC)
            THEN approval_add_author(content_authors, ${req.user.id}::UUID) ELSE content_authors END,
          template_name = COALESCE(${templateName || null}, template_name),
          frequency = COALESCE(${frequency || null}, frequency),
          next_run_date = COALESCE(${nextRunDate || null}, next_run_date),
          end_date = CASE WHEN ${endDate.provided}::BOOLEAN THEN ${endDate.value}::DATE ELSE end_date END,
          description = COALESCE(${description || null}, description),
          line_items = COALESCE(${lines}::JSONB, line_items),
          tax_rate = ${taxRate}::NUMERIC,
          subtotal = CASE WHEN ${lineItems ? 'true' : 'false'} = 'true' THEN ${subtotal} ELSE subtotal END,
          tax_amount = CASE WHEN ${lineItems ? 'true' : 'false'} = 'true' THEN ${taxAmount} ELSE tax_amount END,
          total_amount = CASE WHEN ${lineItems ? 'true' : 'false'} = 'true' THEN ${totalAmount} ELSE total_amount END,
          updated_at = NOW()
        WHERE id = ${id}::UUID AND company_id = ${companyId} AND status IN ('active', 'paused')
      `;
      log.info('Recurring invoice updated', { id });
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      if (err instanceof RecurringInvoiceEditError) return apiResponse.badRequest(res, err.message);
      if (respondIfLockTimeout(res, err)) return;
      log.error('Recurring invoice update failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Update failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
