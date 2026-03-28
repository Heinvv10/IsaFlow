/**
 * Suppliers List API
 * GET  /api/accounting/suppliers-list    - List suppliers (optional ?q= search)
 * POST /api/accounting/suppliers-list    - Create a new supplier
 *
 * Named suppliers-list.ts to avoid conflict with any existing suppliers route.
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
  // ─── GET: List suppliers ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { q } = req.query;
      const searchTerm = typeof q === 'string' && q.trim() ? `%${q.trim()}%` : null;


      let rows: Row[];

      if (searchTerm) {
        rows = (await sql`
          SELECT
            id, name, company_name, email, phone,
            contact_person, is_active,
            vat_number, payment_terms,
            created_at
          FROM suppliers
          WHERE company_id = ${companyId}
            AND (name ILIKE ${searchTerm}
            OR email ILIKE ${searchTerm}
            OR company_name ILIKE ${searchTerm}
            OR contact_person ILIKE ${searchTerm})
          ORDER BY name ASC
          LIMIT 200
        `) as Row[];
      } else {
        rows = (await sql`
          SELECT
            id, name, company_name, email, phone,
            contact_person, is_active,
            vat_number, payment_terms,
            created_at
          FROM suppliers
          WHERE company_id = ${companyId}
          ORDER BY name ASC
          LIMIT 200
        `) as Row[];
      }

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('suppliers GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, `Failed to fetch suppliers: ${message}`);
    }
  }

  // ─── POST: Create supplier ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const {
        name,
        company_name,
        email,
        phone,
        vat_number,
        registration_number,
        address,
        contact_person,
        payment_terms,
        bank_name,
        bank_account_number,
        bank_branch_code,
        bank_account_type,
        is_active,
        notes,
        category,
      } = req.body as {
        name?: string;
        company_name?: string;
        email?: string;
        phone?: string;
        vat_number?: string;
        registration_number?: string;
        address?: string;
        contact_person?: string;
        payment_terms?: number;
        bank_name?: string | null;
        bank_account_number?: string | null;
        bank_branch_code?: string | null;
        bank_account_type?: string | null;
        is_active?: boolean;
        notes?: string;
        category?: string;
      };

      if (!name?.trim()) {
        return apiResponse.badRequest(res, 'Supplier name is required');
      }

      const rows = (await sql`
        INSERT INTO suppliers (
          company_id, name, company_name, email, phone,
          vat_number, registration_number, address, contact_person,
          payment_terms,
          bank_name, bank_account_number, bank_branch_code, bank_account_type,
          is_active, notes, category
        ) VALUES (
          ${companyId},
          ${name.trim()},
          ${company_name?.trim() || null},
          ${email?.trim() || null},
          ${phone?.trim() || null},
          ${vat_number?.trim() || null},
          ${registration_number?.trim() || null},
          ${address?.trim() || null},
          ${contact_person?.trim() || null},
          ${payment_terms ?? 30},
          ${bank_name ?? null},
          ${bank_account_number ?? null},
          ${bank_branch_code ?? null},
          ${bank_account_type ?? null},
          ${is_active ?? true},
          ${notes?.trim() || null},
          ${category?.trim() || null}
        )
        RETURNING
          id, name, company_name, email, phone,
          vat_number, registration_number, address, contact_person,
          payment_terms,
          bank_name, bank_account_number, bank_branch_code, bank_account_type,
          is_active, notes, category,
          created_at
      `) as Row[];

      log.info('Supplier created', { id: rows[0]?.id, name: rows[0]?.name, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('suppliers POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create supplier');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
});
