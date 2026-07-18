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
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { cacheThrough, cache } from '@/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '@/lib/cache-keys';
import { withErrorHandler } from '@/lib/api-error-handler';
import { listSuppliers } from '@/modules/accounting/services/core/contactDirectoryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
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

      const limitRaw = Number(limitParam);
      const pageRaw = Number(pageParam);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
      const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
      const offset = (page - 1) * limit;
      const searchQuery = typeof q === 'string' && q.trim() ? q : null;

      let rows: Row[];
      let total: number;

      if (searchQuery) {
        // Search queries are not cached — results change with every keystroke
        const result = await listSuppliers(companyId, { search: searchQuery, limit, offset });
        rows = result.suppliers as Row[];
        total = result.total;
      } else if (page === 1) {
        // Only cache the first page of unfiltered results
        const result = await cacheThrough(
          CACHE_KEYS.suppliers(companyId),
          async () => listSuppliers(companyId, { limit, offset }),
          CACHE_TTL.REFERENCE_DATA,
        );
        rows = result.suppliers as Row[];
        total = result.total;
      } else {
        const result = await listSuppliers(companyId, { limit, offset });
        rows = result.suppliers as Row[];
        total = result.total;
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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
