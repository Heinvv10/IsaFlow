/**
 * Customer Invoice Detail API
 * GET  ?id=UUID — single invoice with line items
 * PUT  { id, ...fields } — update draft invoice
 * POST { id, action } — status actions (approve, send, cancel)
 */

import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { UUID, ISODate } from '@/lib/schemas/common';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentService';
type Row = Record<string, unknown>;

const GetQuerySchema = z.object({ id: UUID });

const PutBodySchema = z.object({
  id: UUID,
  notes: z.string().max(2000).optional(),
  internalNotes: z.string().max(2000).optional(),
  dueDate: ISODate.optional(),
});

const PostBodySchema = z.object({
  id: UUID,
  action: z.enum(['approve', 'send', 'cancel']),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const queryParsed = GetQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      return apiResponse.validationError(res, queryParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    const { id } = queryParsed.data;

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
               ci.currency_code, ci.exchange_rate, ci.functional_total,
               ci.created_at, ci.updated_at,
               c.name AS client_name, c.email AS client_email
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.id = ${id}::UUID AND ci.company_id = ${companyId}
      `) as Row[];
      if (rows.length === 0) return apiResponse.notFound(res, 'Invoice', id);

      const items = (await sql`
        SELECT cii.* FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id WHERE cii.invoice_id = ${id}::UUID AND ci.company_id = ${companyId} ORDER BY cii.created_at
      `) as Row[];

      return apiResponse.success(res, { ...rows[0], items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Customer invoice detail GET error', { error: msg }, 'customer-invoice-detail');
      return apiResponse.internalError(res, err, `Failed to load invoice: ${msg}`);
    }
  }

  if (req.method === 'PUT') {
    const putParsed = PutBodySchema.safeParse(req.body);
    if (!putParsed.success) {
      return apiResponse.validationError(res, putParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    const { id, notes, internalNotes, dueDate } = putParsed.data;

    const putResult = await sql`
      UPDATE customer_invoices
      SET notes = COALESCE(${notes || null}, notes),
          internal_notes = COALESCE(${internalNotes || null}, internal_notes),
          due_date = COALESCE(${dueDate || null}, due_date),
          updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId} AND status = 'draft'
      RETURNING id
    `;
    if (putResult.length === 0) {
      return apiResponse.notFound(res, 'Invoice', id);
    }
    log.info('Customer invoice updated', { id });
    return apiResponse.success(res, { updated: true });
  }

  if (req.method === 'POST') {
    const postParsed = PostBodySchema.safeParse(req.body);
    if (!postParsed.success) {
      return apiResponse.validationError(res, postParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    const { id, action } = postParsed.data;

    const validActions: Record<string, string> = {
      approve: 'approved', send: 'sent', cancel: 'cancelled',
    };
    const newStatus = validActions[action];

    const actionResult = await sql`
      UPDATE customer_invoices
      SET status = ${newStatus}, updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId}
      RETURNING id
    `;
    if (actionResult.length === 0) {
      return apiResponse.notFound(res, 'Invoice', id);
    }

    // Post to GL on approve (accrual accounting: DR AR, CR Revenue, CR VAT Output)
    let glJournalEntryId: string | null = null;
    if (action === 'approve') {
      try {
        const userId = (req as CompanyAuthedRequest).user?.id || 'system';
        glJournalEntryId = await postCustomerInvoiceToGL(companyId, id, userId);
        log.info('Customer invoice GL posted on approve', { id, glJournalEntryId });
      } catch (glErr) {
        log.error('GL posting failed on invoice approve (invoice still approved)', { id, error: glErr });
      }
    }

    log.info('Customer invoice action', { id, action, newStatus });
    return apiResponse.success(res, { id, status: newStatus, glJournalEntryId });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
