/**
 * Customers API
 * GET  /api/accounting/customers         - List customers (optional ?q= search)
 * POST /api/accounting/customers         - Create a new customer
 * PUT  /api/accounting/customers         - Edit a customer: { id, ...fields }; a blank text field is cleared
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { COMPANY_DEFAULT_TERMS_KEY } from '@/modules/accounting/services/shared/paymentTerms';
import { apiResponse } from '@/lib/apiResponse';
import { UUID_RE } from '@/lib/validation';
import {
  createCustomer,
  updateCustomer,
} from '@/modules/accounting/services/core/customerWriteService';
import { ContactValidationError } from '@/modules/accounting/services/core/contactValidationError';
import { customerInputFromBody, customerPatchFromBody } from '@/modules/accounting/services/core/contactRequestInput';
import { withCompanyDefaultTerms } from '@/modules/accounting/services/core/companyDefaultTermsRow';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { listCustomers } from '@/modules/accounting/services/core/contactDirectoryService';
import { describeCustomerRevenueAccount } from '@/modules/accounting/services/core/contactRevenueAccount';

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
          SELECT c.id, c.name, c.email, c.phone, c.mobile, c.fax, c.web_address, c.contact_person,
                 c.payment_terms, c.payment_terms_type, c.default_discount, c.default_vat_type,
                 c.default_price_list, c.credit_limit, c.is_active, c.cash_sale, c.accepts_electronic_invoices,
                 c.invoices_viewable_online, c.subject_to_drc_vat, c.statement_distribution,
                 c.auto_allocate_strategy, c.category_id, c.billing_address, c.shipping_address, c.notes,
                 c.vat_number, c.registration_number, c.default_revenue_account_id, c.created_at,
                 d.value AS company_default_terms
          FROM customers c
          LEFT JOIN accounting_settings d ON d.company_id = c.company_id AND d.key = ${COMPANY_DEFAULT_TERMS_KEY}
          WHERE c.id = ${id}::uuid AND c.company_id = ${companyId} AND c.deleted_at IS NULL
        `) as Row[];
        if (found.length === 0) return apiResponse.notFound(res, 'Customer');
        // The stored default revenue account with its label and whether it may still be used (migration 966).
        const revenueAccount = await describeCustomerRevenueAccount(companyId, found[0]!.default_revenue_account_id as string | null);
        return apiResponse.success(res, { ...withCompanyDefaultTerms(found[0]!, companyId), default_revenue_account: revenueAccount });
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
      const rows = [await createCustomer(companyId, customerInputFromBody(req.body))];

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
