/**
 * Customers API
 * GET  /api/accounting/customers         - List customers (optional ?q= search)
 * POST /api/accounting/customers         - Create a new customer
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import {
  createCustomer,
  ContactValidationError,
} from '@/modules/accounting/services/core/customerWriteService';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { cacheThrough, cache } from '@/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '@/lib/cache-keys';
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

      const searchQuery = typeof q === 'string' ? q : null;

      let rows: Row[];

      if (searchQuery && searchQuery.trim()) {
        // Search queries are not cached — results change with every keystroke
        rows = await listCustomers(companyId, searchQuery);
      } else {
        rows = await cacheThrough(
          CACHE_KEYS.customers(companyId),
          async () => listCustomers(companyId, null),
          CACHE_TTL.REFERENCE_DATA,
        );
      }

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
      const b = req.body as Record<string, unknown>;
      const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
      const n = (k: string) => {
        const v = b[k];
        return v !== undefined && v !== null && v !== '' ? Number(v) : undefined;
      };
      const bool = (k: string) => (typeof b[k] === 'boolean' ? (b[k] as boolean) : undefined);

      // Field validation and the INSERT itself live in customerWriteService, so
      // this route and create_customer over MCP cannot drift apart.
      const rows = [await createCustomer(companyId, {
        name: s('name'),
        email: s('email'), phone: s('phone'), mobile: s('mobile'), fax: s('fax'),
        webAddress: s('web_address'),
        vatNumber: s('vat_number'), registrationNumber: s('registration_number'),
        billingAddress: s('billing_address'), shippingAddress: s('shipping_address'),
        contactPerson: s('contact_person'),
        paymentTerms: n('payment_terms'), paymentTermsType: s('payment_terms_type'),
        creditLimit: n('credit_limit'), isActive: bool('is_active'), notes: s('notes'),
        categoryId: s('category_id'), cashSale: bool('cash_sale'),
        openingBalance: n('opening_balance'), openingBalanceDate: s('opening_balance_date'),
        acceptsElectronicInvoices: bool('accepts_electronic_invoices'),
        autoAllocateReceipts: bool('auto_allocate_receipts'),
        statementDistribution: s('statement_distribution'),
        defaultDiscount: n('default_discount'), defaultVatType: s('default_vat_type'),
        subjectToDrcVat: bool('subject_to_drc_vat'),
        invoicesViewableOnline: bool('invoices_viewable_online'),
        defaultPriceList: s('default_price_list'),
      })];

      cache.invalidate(CACHE_KEYS.customers(companyId));
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

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
