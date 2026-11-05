/**
 * Customers API
 * GET  /api/accounting/customers         - List customers (optional ?q= search)
 * POST /api/accounting/customers         - Create a new customer
 * PUT  /api/accounting/customers         - Edit a customer: { id, ...fields }; a blank text field is cleared
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { UUID_RE } from '@/lib/validation';
import {
  createCustomer,
  updateCustomer,
  ContactValidationError,
} from '@/modules/accounting/services/core/customerWriteService';
import { customerInputFromBody, customerPatchFromBody } from '@/modules/accounting/services/core/contactRequestInput';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { listCustomers } from '@/modules/accounting/services/core/contactDirectoryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  // ─── GET: List customers ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { q, id, include } = req.query;

      // ── Activity feed for a specific customer ────────────────────────────
      if (id && include === 'activity') {
        const customerId = id as string;
        const activity = (await sql`
          SELECT
            id,
            invoice_number AS reference,
            invoice_date   AS date,
            due_date,
            total_amount,
            status,
            'invoice' AS type
          FROM customer_invoices
          WHERE company_id = ${companyId}
            AND COALESCE(client_id, customer_id) = ${customerId}::uuid
            AND deleted_at IS NULL

          UNION ALL

          SELECT
            id,
            payment_number AS reference,
            payment_date   AS date,
            NULL           AS due_date,
            total_amount,
            status,
            'payment' AS type
          FROM customer_payments
          WHERE company_id = ${companyId}
            AND client_id = ${customerId}::uuid

          UNION ALL

          SELECT
            id,
            credit_note_number AS reference,
            credit_date        AS date,
            NULL               AS due_date,
            total_amount,
            status,
            'credit_note' AS type
          FROM credit_notes
          WHERE company_id = ${companyId}
            AND client_id = ${customerId}::uuid
            AND type = 'customer'

          ORDER BY date DESC NULLS LAST
          LIMIT 100
        `) as Row[];
        return apiResponse.success(res, activity);
      }

      // Single customer: names a preselected id that is not in the first page (ContactPicker), and gives the new-invoice
      // page its defaults (useContactDefaults). A bare `?id=` that is
      // not a UUID keeps its old answer (the list), which the detail page still filters itself.
      if (typeof id === 'string' && UUID_RE.test(id)) {
        const found = (await sql`
          SELECT id, name, email, phone, mobile, fax, web_address, contact_person, payment_terms, payment_terms_type,
                 default_discount, default_vat_type, default_price_list, credit_limit, is_active, cash_sale,
                 accepts_electronic_invoices, invoices_viewable_online, subject_to_drc_vat, statement_distribution,
                 auto_allocate_strategy, category_id, billing_address, shipping_address, notes,
                 vat_number, registration_number, created_at
          FROM customers
          WHERE id = ${id}::uuid AND company_id = ${companyId} AND deleted_at IS NULL
        `) as Row[];
        if (found.length === 0) return apiResponse.notFound(res, 'Customer');
        return apiResponse.success(res, found[0]);
      }

      const searchQuery = typeof q === 'string' ? q : null;
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 200) : 200;

      // Not cached (R-125): ten files write customers, and an in-process
      // cache is invisible to every other process.
      const rows = await listCustomers(companyId, searchQuery, { limit, offset: 0 });

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customers GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to fetch customers');
    }
  }

  // ─── POST: Create customer ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      // Field validation and the INSERT itself live in customerWriteService, so this route, the edit (PUT) and
      // create_customer over MCP cannot drift apart.
      const rows = [await createCustomer(companyId, customerInputFromBody(req.body as Record<string, unknown>))];

      log.info('Customer created', { id: rows[0]?.id, name: rows[0]?.name, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      if (err instanceof ContactValidationError) {
        return apiResponse.badRequest(res, err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error('customers POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create customer');
    }
  }

  // ─── PUT: Edit a customer ───────────────────────────────────────────────────
  // The same update the MCP update_customer tool runs, so the entity history row (entity_change_capture, a trigger)
  // is written the same way: under this request's transaction, as this user.
  if (req.method === 'PUT') {
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id : '';
    if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'id must be a customer id');
    try {
      const row = await updateCustomer(companyId, id, customerPatchFromBody(b));
      if (!row) return apiResponse.notFound(res, 'Customer');
      log.info('Customer updated', { id, module: 'accounting' });
      return apiResponse.success(res, { id: String(row.id), name: String(row.name), is_active: row.is_active });
    } catch (err: unknown) {
      if (err instanceof ContactValidationError) return apiResponse.badRequest(res, err.message);
      const message = err instanceof Error ? err.message : String(err);
      log.error('customers PUT failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to update customer');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
