/**
 * Customers API
 * GET  /api/accounting/customers         - List customers (optional ?q= search)
 * POST /api/accounting/customers         - Create a new customer
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCompany, type CompanyApiRequest } from '@/lib/auth';
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
      const {
        name,
        email,
        phone,
        vat_number,
        registration_number,
        billing_address,
        shipping_address,
        contact_person,
        payment_terms,
        credit_limit,
        is_active,
        notes,
      } = req.body as {
        name?: string;
        email?: string;
        phone?: string;
        vat_number?: string;
        registration_number?: string;
        billing_address?: string;
        shipping_address?: string;
        contact_person?: string;
        payment_terms?: number;
        credit_limit?: number | null;
        is_active?: boolean;
        notes?: string;
      };

      if (!name?.trim()) {
        return apiResponse.badRequest(res, 'Customer name is required');
      }

      const rows = (await sql`
        INSERT INTO customers (
          company_id, name, email, phone, vat_number, registration_number,
          billing_address, shipping_address, contact_person,
          payment_terms, credit_limit, is_active, notes
        ) VALUES (
          ${companyId},
          ${name.trim()},
          ${email?.trim() || null},
          ${phone?.trim() || null},
          ${vat_number?.trim() || null},
          ${registration_number?.trim() || null},
          ${billing_address?.trim() || null},
          ${shipping_address?.trim() || null},
          ${contact_person?.trim() || null},
          ${payment_terms ?? 30},
          ${credit_limit ?? null},
          ${is_active ?? true},
          ${notes?.trim() || null}
        )
        RETURNING
          id, name, email, phone, vat_number, registration_number,
          billing_address, shipping_address, contact_person,
          payment_terms, credit_limit, is_active, notes,
          created_at
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
