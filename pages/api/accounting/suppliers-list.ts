/**
 * Suppliers List API
 * GET  /api/accounting/suppliers-list    - List suppliers (optional ?q= search)
 * POST /api/accounting/suppliers-list    - Create a new supplier
 * PATCH /api/accounting/suppliers-list   - Set { id, subject_to_drc_vat } (the DRC toggle on the detail page)
 * PUT   /api/accounting/suppliers-list   - Edit a supplier: { id, ...fields }; a blank text field is cleared; any bank field is a 400
 *
 * Named suppliers-list.ts to avoid conflict with any existing suppliers route.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { UUID_RE } from '@/lib/validation';
import { createSupplier, updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { supplierInputFromBody, supplierPatchFromBody } from '@/modules/accounting/services/core/contactRequestInput';
import { ContactValidationError } from '@/modules/accounting/services/core/customerWriteService';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
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
      if (singleId !== undefined) {
        // It reaches a ::UUID cast below: anything else is a 400 here, not a 22P02 500.
        if (typeof singleId !== 'string' || !UUID_RE.test(singleId)) return apiResponse.badRequest(res, 'id must be a supplier id');
        const rows = (await sql`
          SELECT id, name, company_name, email, phone,
                 contact_person, is_active, vat_number, registration_number, address, category, notes, whatsapp_number,
                 auto_allocate_strategy,
                 payment_terms, payment_terms_type, subject_to_drc_vat, created_at
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

      // Not cached: merge, soft-delete, MCP, capture and the import services all
      // write `suppliers` without passing through this route, so no invalidation
      // here could keep a cached page honest (K-139).
      const result = await listSuppliers(companyId, { search: searchQuery ?? undefined, limit, offset });
      const rows = result.suppliers as Row[];
      const total = result.total;

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
      // Field validation and the INSERT live in supplierWriteService, so this route, the edit (PUT) and
      // create_supplier over MCP cannot drift apart.
      const rows = [await createSupplier(
        companyId, supplierInputFromBody(req.body as Record<string, unknown>), (req as CompanyAuthedRequest).user.id,
      )];

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
  // The DRC toggle on the detail page. The general edit is PUT below.
  if (req.method === 'PATCH') {
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id : '';
    if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'id must be a supplier id');
    if (typeof b.subject_to_drc_vat !== 'boolean') {
      return apiResponse.badRequest(res, 'subject_to_drc_vat must be true or false');
    }
    const row = await updateSupplier(companyId, id, { subjectToDrcVat: b.subject_to_drc_vat },
      (req as CompanyAuthedRequest).user.id);
    if (!row) return apiResponse.notFound(res, 'Supplier');
    log.info('Supplier DRC flag set', { id, subjectToDrcVat: b.subject_to_drc_vat, module: 'accounting' });
    return apiResponse.success(res, { id, subject_to_drc_vat: row.subject_to_drc_vat });
  }

  // ─── PUT: Edit a supplier ───────────────────────────────────────────────────
  // The general edit. Deliberately NOT a bank editor: a general update route would put bank details one request away
  // from any writer, so a body naming any bank field is a 400 (supplierPatchFromBody), never ignored, and the bank-details
  // stamp (R-035 PR5) cannot be reached for a bank change from here. Bank details change through MCP update_supplier or
  // the migration import, each stamped. A rename still goes through updateSupplier's stamp (the payee name is in the
  // payment digest, migration 923). The entity history row (entity_change_capture, a trigger) is written under this
  // request's transaction, as this user.
  if (req.method === 'PUT') {
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id : '';
    if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'id must be a supplier id');
    try {
      const row = await updateSupplier(companyId, id, supplierPatchFromBody(b), (req as CompanyAuthedRequest).user.id);
      if (!row) return apiResponse.notFound(res, 'Supplier');
      log.info('Supplier updated', { id, module: 'accounting' });
      return apiResponse.success(res, { id: String(row.id), name: String(row.name), is_active: row.is_active });
    } catch (err: unknown) {
      if (err instanceof ContactValidationError) return apiResponse.badRequest(res, err.message);
      const message = err instanceof Error ? err.message : String(err);
      log.error('suppliers PUT failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to update supplier');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
