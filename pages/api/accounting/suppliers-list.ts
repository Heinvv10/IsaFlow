/**
 * Suppliers List API
 * GET  /api/accounting/suppliers-list    - List suppliers (optional ?q= search)
 * POST /api/accounting/suppliers-list    - Create a new supplier
 * PATCH /api/accounting/suppliers-list   - Set { id, subject_to_drc_vat } — the one supplier field the UI edits
 *
 * Named suppliers-list.ts to avoid conflict with any existing suppliers route.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { UUID_RE } from '@/lib/validation';
import { createSupplier, updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import type { AutoAllocateStrategy } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { ContactValidationError } from '@/modules/accounting/services/core/customerWriteService';
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
                 contact_person, is_active, vat_number, payment_terms, subject_to_drc_vat, created_at
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
      } else if (page === 1 && limit === 25) {
        // Only cache the default page size — a different limit on page 1
        // would otherwise be served the 25 rows cached for the default call.
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
      const b = req.body as Record<string, unknown>;
      const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
      const num = (k: string) => {
        const v = b[k];
        return v !== undefined && v !== null && v !== '' ? Number(v) : undefined;
      };
      const bool = (k: string) => (typeof b[k] === 'boolean' ? (b[k] as boolean) : undefined);

      // Field validation and the INSERT live in supplierWriteService, so this
      // route and create_supplier over MCP cannot drift apart.
      const rows = [await createSupplier(companyId, {
        name: str('name'),
        companyName: str('company_name'),
        email: str('email'), phone: str('phone'),
        vatNumber: str('vat_number'), registrationNumber: str('registration_number'),
        address: str('address'), contactPerson: str('contact_person'),
        paymentTerms: num('payment_terms'),
        bankName: str('bank_name'), bankAccountNumber: str('bank_account_number'),
        bankBranchCode: str('bank_branch_code'), bankAccountType: str('bank_account_type'),
        isActive: bool('is_active'), notes: str('notes'), category: str('category'),
        openingBalance: num('opening_balance'), openingBalanceDate: str('opening_balance_date'),
        // auto_allocate_strategy is the only field that decides this. The
        // legacy boolean below is still ACCEPTED and still written to its own
        // column, but it no longer selects a strategy: an old client sending
        // only `auto_allocate_payments: true` gets no error and no effect.
        // That is deliberate — migration 614 refused to carry the historical
        // ticks over because nothing ever read them, so nobody consented to
        // automatic cash application by ticking one, and honouring the same
        // tick over the wire would re-open the door the migration closed.
        autoAllocateStrategy: str('auto_allocate_strategy') as AutoAllocateStrategy | undefined,
        autoAllocatePayments: bool('auto_allocate_payments'),
        subjectToDrcVat: bool('subject_to_drc_vat'),
      })];

      cache.invalidate(CACHE_KEYS.suppliers(companyId));
      log.info('Supplier created', { id: rows[0]?.id, name: rows[0]?.name, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      if (err instanceof ContactValidationError) {
        return apiResponse.badRequest(res, err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error('suppliers POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create supplier');
    }
  }

  // ─── PATCH: the DRC flag ────────────────────────────────────────────────────
  // Deliberately this ONE field: there is no supplier edit screen, and a general
  // update route would put bank details one request away from any writer.
  if (req.method === 'PATCH') {
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id : '';
    if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'id must be a supplier id');
    if (typeof b.subject_to_drc_vat !== 'boolean') {
      return apiResponse.badRequest(res, 'subject_to_drc_vat must be true or false');
    }
    const row = await updateSupplier(companyId, id, { subjectToDrcVat: b.subject_to_drc_vat });
    if (!row) return apiResponse.notFound(res, 'Supplier');
    cache.invalidate(CACHE_KEYS.suppliers(companyId));
    log.info('Supplier DRC flag set', { id, subjectToDrcVat: b.subject_to_drc_vat, module: 'accounting' });
    return apiResponse.success(res, { id, subject_to_drc_vat: row.subject_to_drc_vat });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
