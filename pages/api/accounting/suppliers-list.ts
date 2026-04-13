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
import { withCompany, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { cacheThrough, cache } from '@/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '@/lib/cache-keys';
import { withErrorHandler } from '@/lib/api-error-handler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  // ─── GET: List suppliers ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { id: singleId, q, limit: limitParam = '25', page: pageParam = '1' } = req.query;

      // Single-supplier lookup: ?id=<uuid>
      if (typeof singleId === 'string') {
        const rows = (await sql`
          SELECT id, name, company_name, email, phone,
                 contact_person, is_active, vat_number, payment_terms, created_at
          FROM suppliers
          WHERE id = ${singleId}::UUID AND company_id = ${companyId} AND deleted_at IS NULL
        `) as Row[];
        if (rows.length === 0) return apiResponse.notFound(res, 'Supplier');
        return apiResponse.success(res, rows[0]);
      }

      const limit = Math.min(Number(limitParam), 200);
      const page = Math.max(1, Number(pageParam));
      const offset = (page - 1) * limit;
      const searchTerm = typeof q === 'string' && q.trim() ? `%${q.trim()}%` : null;

      let rows: Row[];
      let total: number;

      if (searchTerm) {
        // Search queries are not cached — results change with every keystroke
        const [dataRows, countResult] = await Promise.all([
          sql`
            SELECT
              id, name, company_name, email, phone,
              contact_person, is_active,
              vat_number, payment_terms,
              created_at
            FROM suppliers
            WHERE company_id = ${companyId}
              AND deleted_at IS NULL
              AND (name ILIKE ${searchTerm}
              OR email ILIKE ${searchTerm}
              OR company_name ILIKE ${searchTerm}
              OR contact_person ILIKE ${searchTerm})
            ORDER BY name ASC
            LIMIT ${limit} OFFSET ${offset}
          `,
          sql`
            SELECT COUNT(*) as total FROM suppliers
            WHERE company_id = ${companyId}
              AND deleted_at IS NULL
              AND (name ILIKE ${searchTerm}
              OR email ILIKE ${searchTerm}
              OR company_name ILIKE ${searchTerm}
              OR contact_person ILIKE ${searchTerm})
          `,
        ]);
        rows = dataRows as Row[];
        total = Number(countResult[0]?.total ?? 0);
      } else {
        // Only cache the first page of unfiltered results
        const [dataRows, countResult] = await Promise.all([
          page === 1
            ? cacheThrough(
                CACHE_KEYS.suppliers(companyId),
                async () => (await sql`
                  SELECT
                    id, name, company_name, email, phone,
                    contact_person, is_active,
                    vat_number, payment_terms,
                    created_at
                  FROM suppliers
                  WHERE company_id = ${companyId}
                    AND deleted_at IS NULL
                  ORDER BY name ASC
                  LIMIT ${limit} OFFSET ${offset}
                `) as Row[],
                CACHE_TTL.REFERENCE_DATA,
              )
            : (await sql`
                SELECT
                  id, name, company_name, email, phone,
                  contact_person, is_active,
                  vat_number, payment_terms,
                  created_at
                FROM suppliers
                WHERE company_id = ${companyId}
                  AND deleted_at IS NULL
                ORDER BY name ASC
                LIMIT ${limit} OFFSET ${offset}
              `) as Row[],
          sql`
            SELECT COUNT(*) as total FROM suppliers
            WHERE company_id = ${companyId}
              AND deleted_at IS NULL
          `,
        ]);
        rows = dataRows;
        total = Number(countResult[0]?.total ?? 0);
      }

      return apiResponse.success(res, { suppliers: rows, total });
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
        opening_balance,
        opening_balance_date,
        auto_allocate_payments,
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
        opening_balance?: number | string | null;
        opening_balance_date?: string | null;
        auto_allocate_payments?: boolean;
      };

      if (!name?.trim()) {
        return apiResponse.badRequest(res, 'Supplier name is required');
      }

      const obDate = typeof opening_balance_date === 'string' && opening_balance_date.trim()
        ? opening_balance_date.trim()
        : null;

      const rows = (await sql`
        INSERT INTO suppliers (
          company_id, name, company_name, email, phone,
          vat_number, registration_number, address, contact_person,
          payment_terms,
          bank_name, bank_account_number, bank_branch_code, bank_account_type,
          is_active, notes, category,
          opening_balance, opening_balance_date, auto_allocate_payments
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
          ${category?.trim() || null},
          ${opening_balance !== undefined && opening_balance !== null && opening_balance !== '' ? Number(opening_balance) : 0},
          ${obDate}::date,
          ${auto_allocate_payments ?? false}
        )
        RETURNING
          id, name, company_name, email, phone,
          vat_number, registration_number, address, contact_person,
          payment_terms,
          bank_name, bank_account_number, bank_branch_code, bank_account_type,
          is_active, notes, category,
          opening_balance, opening_balance_date, auto_allocate_payments,
          created_at
      `) as Row[];

      cache.invalidate(CACHE_KEYS.suppliers(companyId));
      log.info('Supplier created', { id: rows[0]?.id, name: rows[0]?.name, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('suppliers POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create supplier');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
