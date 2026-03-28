/**
 * Customer Invoice Detail API
 * GET  ?id=UUID — single invoice with line items
 * PUT  { id, ...fields } — update draft invoice
 * POST { id, action } — status actions (approve, send, cancel)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return apiResponse.badRequest(res, 'id is required');

    try {
      const rows = (await sql`
        SELECT ci.id, ci.invoice_number, ci.customer_id, ci.client_id,
               ci.billing_period_start, ci.billing_period_end,
               ci.subtotal, ci.tax_rate, ci.tax_amount, ci.total_amount,
               ci.amount_paid, ci.status, ci.invoice_date, ci.due_date,
               ci.sent_at, ci.paid_at, ci.notes, ci.internal_notes,
               ci.project_id, ci.gl_journal_entry_id,
               ci.email_sent_at, ci.email_sent_to,
               ci.online_payment_enabled, ci.payment_url,
               ci.created_at, ci.updated_at,
               c.name AS client_name, c.email AS client_email
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.id = ${id as string}::UUID AND ci.company_id = ${companyId}
      `) as Row[];
      if (rows.length === 0) return apiResponse.notFound(res, 'Invoice', id as string);

      const items = (await sql`
        SELECT * FROM customer_invoice_items WHERE invoice_id = ${id as string}::UUID ORDER BY created_at
      `) as Row[];

      return apiResponse.success(res, { ...rows[0], items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Customer invoice detail GET error', { error: msg }, 'customer-invoice-detail');
      return apiResponse.internalError(res, err, `Failed to load invoice: ${msg}`);
    }
  }

  if (req.method === 'PUT') {
    const { id, notes, internalNotes, dueDate } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');

    await sql`
      UPDATE customer_invoices
      SET notes = COALESCE(${notes || null}, notes),
          internal_notes = COALESCE(${internalNotes || null}, internal_notes),
          due_date = COALESCE(${dueDate || null}, due_date),
          updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId} AND status = 'draft'
    `;
    log.info('Customer invoice updated', { id });
    return apiResponse.success(res, { updated: true });
  }

  if (req.method === 'POST') {
    const { id, action } = req.body;
    if (!id || !action) return apiResponse.badRequest(res, 'id and action required');

    const validActions: Record<string, string> = {
      approve: 'approved', send: 'sent', cancel: 'cancelled',
    };
    const newStatus = validActions[action];
    if (!newStatus) return apiResponse.badRequest(res, `Unknown action: ${action}`);

    await sql`UPDATE customer_invoices SET status = ${newStatus}, updated_at = NOW() WHERE id = ${id}::UUID AND company_id = ${companyId}`;
    log.info('Customer invoice action', { id, action, newStatus });
    return apiResponse.success(res, { id, status: newStatus });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
