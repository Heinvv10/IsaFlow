/**
 * Customers API
 * GET  /api/accounting/customers         - List customers (optional ?q= search)
 * POST /api/accounting/customers         - Create a new customer
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export default withCompany(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  // ─── GET: List customers ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { q } = req.query;
      const searchTerm = typeof q === 'string' && q.trim() ? `%${q.trim()}%` : null;

      let rows: Row[];

      if (searchTerm) {
        rows = (await sql`
          SELECT
            id, name, email, phone, contact_person,
            payment_terms, credit_limit, is_active,
            vat_number, registration_number,
            created_at
          FROM customers
          WHERE company_id = ${companyId}
            AND (name ILIKE ${searchTerm}
            OR email ILIKE ${searchTerm}
            OR vat_number ILIKE ${searchTerm}
            OR contact_person ILIKE ${searchTerm})
          ORDER BY name ASC
          LIMIT 200
        `) as Row[];
      } else {
        rows = (await sql`
          SELECT
            id, name, email, phone, contact_person,
            payment_terms, credit_limit, is_active,
            vat_number, registration_number,
            created_at
          FROM customers
          WHERE company_id = ${companyId}
          ORDER BY name ASC
          LIMIT 200
        `) as Row[];
      }

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Return empty list if table does not yet exist
      if (message.includes('does not exist')) {
        return apiResponse.success(res, []);
      }
      log.error('customers GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to fetch customers');
    }
  }

  // ─── POST: Create customer ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const b = req.body as Record<string, unknown>;
      const name = b.name as string | undefined;

      if (!name?.trim()) {
        return apiResponse.badRequest(res, 'Customer name is required');
      }

      const s = (k: string) => { const v = b[k]; return typeof v === 'string' && v.trim() ? v.trim() : null; };
      const n = (k: string) => { const v = b[k]; return v !== undefined && v !== null && v !== '' ? Number(v) : null; };
      const bool = (k: string, def = false) => { const v = b[k]; return typeof v === 'boolean' ? v : def; };

      const rows = (await sql`
        INSERT INTO customers (
          company_id, name, email, phone, mobile, fax, web_address,
          vat_number, registration_number,
          billing_address, shipping_address, contact_person,
          payment_terms, payment_terms_type, credit_limit, is_active, notes,
          category_id, cash_sale, opening_balance, opening_balance_date,
          accepts_electronic_invoices, auto_allocate_receipts,
          statement_distribution, default_discount, default_vat_type,
          subject_to_drc_vat, invoices_viewable_online
        ) VALUES (
          ${companyId},
          ${name.trim()},
          ${s('email')},
          ${s('phone')},
          ${s('mobile')},
          ${s('fax')},
          ${s('web_address')},
          ${s('vat_number')},
          ${s('registration_number')},
          ${s('billing_address')},
          ${s('shipping_address')},
          ${s('contact_person')},
          ${n('payment_terms') ?? 30},
          ${s('payment_terms_type') ?? 'days'},
          ${n('credit_limit')},
          ${bool('is_active', true)},
          ${s('notes')},
          ${s('category_id') ? s('category_id') : null}::uuid,
          ${bool('cash_sale')},
          ${n('opening_balance') ?? 0},
          ${s('opening_balance_date')}::date,
          ${bool('accepts_electronic_invoices')},
          ${bool('auto_allocate_receipts')},
          ${s('statement_distribution') ?? 'email'},
          ${n('default_discount') ?? 0},
          ${s('default_vat_type')},
          ${bool('subject_to_drc_vat')},
          ${bool('invoices_viewable_online', true)}
        )
        RETURNING *
      `) as Row[];

      log.info('Customer created', { id: rows[0]?.id, name: rows[0]?.name, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customers POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create customer');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
});
