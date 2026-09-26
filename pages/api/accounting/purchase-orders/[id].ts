/**
 * Purchase Order Detail API
 * GET    /api/accounting/purchase-orders/[id] — Get single PO with line items
 * PUT    /api/accounting/purchase-orders/[id] — Update draft PO
 * DELETE /api/accounting/purchase-orders/[id] — Delete draft PO
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type CompanyAuthedRequest,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertSupplierInCompany, SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { DocumentLineAccountRefusal, assertDocumentLineAccounts } from '@/modules/accounting/services/gl/documentLineAccountGuard';

type Row = Record<string, unknown>;

// Keep in step with the status IN (...) guard in the PUT's UPDATE.
const EDITABLE_STATUSES = ['draft', 'submitted'];

async function readStatus(id: string, companyId: string): Promise<string | null> {
  const rows = await sql`
    SELECT status FROM purchase_orders
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  ` as Row[];
  return rows.length === 0 ? null : String(rows[0]!.status);
}

function refuseStatus(res: NextApiResponse, status: string) {
  return apiResponse.badRequest(res, `Only draft or submitted purchase orders can be edited (this one is ${status})`);
}

function refuseDelete(res: NextApiResponse, status: string) {
  return apiResponse.badRequest(res, `Only draft purchase orders can be deleted (this one is ${status})`);
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'id is required');

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) return apiResponse.notFound(res, 'Purchase order', id);

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const poRows = await sql`
      SELECT po.*,
        s.name    AS supplier_name,
        s.email   AS supplier_email,
        s.phone   AS supplier_phone,
        s.address AS supplier_address
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.id = ${id}::UUID AND po.company_id = ${companyId}::UUID
    ` as Row[];

    if (poRows.length === 0) return apiResponse.notFound(res, 'Purchase order', id);

    const items = await sql`
      SELECT pi.*, g.account_name, g.account_code
      FROM po_items pi
      LEFT JOIN gl_accounts g ON g.id = pi.gl_account_id
      WHERE pi.purchase_order_id = ${id}::UUID
      ORDER BY pi.sort_order
    ` as Row[];

    return apiResponse.success(res, { ...poRows[0], items });
  }

  // ── PUT ────────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const {
      supplier_id,
      order_date,
      expected_delivery_date,
      reference,
      notes,
      status,
      items,
    } = req.body as {
      supplier_id?: string;
      order_date?: string;
      expected_delivery_date?: string | null;
      reference?: string | null;
      notes?: string | null;
      status?: string;
      items?: Array<{
        id?: string;
        description: string;
        quantity: number;
        unit_price: number;
        tax_rate?: number;
        gl_account_id?: string | null;
        product_id?: string | null;
        sort_order?: number;
      }>;
    };

    // Fetch current PO to verify ownership and answer early on a non-editable
    // status. This read is not the guard: the status can change before the
    // UPDATE below, which carries the same check in its WHERE (R-126).
    const existing = await readStatus(id, companyId);
    if (existing === null) return apiResponse.notFound(res, 'Purchase order', id);
    if (!EDITABLE_STATUSES.includes(existing)) return refuseStatus(res, existing);

    // R-068: supplier_id comes from the body; refused before the UPDATE.
    try {
      await assertSupplierInCompany(companyId, supplier_id);
    } catch (err) {
      if (err instanceof SupplierNotInCompanyError) return apiResponse.badRequest(res, err.message);
      throw err;
    }

    // Before the first write: an inactive or foreign account on a replacement
    // line would otherwise land in po_items with nothing to catch it — the
    // same window a GL account merge opens on every other document-line
    // writer (gl/documentLineAccountGuard.ts). The PUT replaces every line, so
    // an untouched line on a since-deactivated account must not block an
    // unrelated edit: each account is exempt only up to the number of lines
    // the PO already had on it. Any line beyond that is new and is checked.
    if (Array.isArray(items) && items.length > 0) {
      const kept = new Map(((await sql`
        SELECT lower(gl_account_id::TEXT) AS a, COUNT(*)::INT AS n FROM po_items
         WHERE purchase_order_id = ${id}::UUID AND gl_account_id IS NOT NULL
         GROUP BY 1
      `) as Row[]).map((r) => [String(r.a), Number(r.n)] as const));
      const toCheck = items.map((i) => i.gl_account_id).filter((a) => {
        const key = a ? String(a).toLowerCase() : '';
        const left = kept.get(key) ?? 0;
        if (left > 0) { kept.set(key, left - 1); return false; }
        return true;
      });
      try {
        await assertDocumentLineAccounts(companyId, toCheck);
      } catch (err) {
        if (err instanceof DocumentLineAccountRefusal) return apiResponse.badRequest(res, err.message);
        throw err;
      }
    }

    // Compute totals from items if provided
    let subtotal: number | undefined;
    let taxAmount: number | undefined;
    let total: number | undefined;

    if (Array.isArray(items) && items.length > 0) {
      subtotal = 0;
      taxAmount = 0;
      for (const item of items) {
        const lineTotal = Math.round((item.quantity || 0) * (item.unit_price || 0) * 100) / 100;
        const lineTax = Math.round(lineTotal * ((item.tax_rate ?? 15) / 100) * 100) / 100;
        subtotal += lineTotal;
        taxAmount += lineTax;
      }
      total = Math.round((subtotal + taxAmount) * 100) / 100;
    }

    const updated = await sql`
      UPDATE purchase_orders SET
        supplier_id            = COALESCE(${supplier_id ?? null}::UUID, supplier_id),
        order_date             = COALESCE(${order_date ?? null}::DATE, order_date),
        expected_delivery_date = ${expected_delivery_date !== undefined ? expected_delivery_date : null},
        reference              = ${reference !== undefined ? reference : null},
        notes                  = ${notes !== undefined ? notes : null},
        status                 = COALESCE(${status ?? null}, status),
        subtotal               = COALESCE(${subtotal ?? null}, subtotal),
        tax_amount             = COALESCE(${taxAmount ?? null}, tax_amount),
        total                  = COALESCE(${total ?? null}, total),
        updated_at             = NOW(),
        updated_by             = ${String(req.user.id)}
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
        AND status IN ('draft', 'submitted')
      RETURNING *
    ` as Row[];

    if (updated.length === 0) {
      const now = await readStatus(id, companyId);
      if (now === null) return apiResponse.notFound(res, 'Purchase order', id);
      // Editable again by the time of this read: the caller's view is stale.
      if (EDITABLE_STATUSES.includes(now)) {
        return apiResponse.conflict(res, 'The purchase order changed while saving; reload and try again');
      }
      return refuseStatus(res, now);
    }

    // Replace line items if provided
    if (Array.isArray(items) && items.length > 0) {
      // Parent-verified: the UPDATE above scopes to company_id and returns early when no row matches, so this id is tenant-owned.
      await sql`DELETE FROM po_items WHERE purchase_order_id = ${id}::UUID`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const lineTotal = Math.round((item.quantity || 0) * (item.unit_price || 0) * 100) / 100;
        const lineTax = Math.round(lineTotal * ((item.tax_rate ?? 15) / 100) * 100) / 100;
        await sql`
          INSERT INTO po_items
            (purchase_order_id, product_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id, sort_order)
          VALUES
            (${id}::UUID,
             ${item.product_id ?? null},
             ${item.description},
             ${item.quantity},
             ${item.unit_price},
             ${item.tax_rate ?? 15},
             ${lineTotal},
             ${lineTax},
             ${item.gl_account_id ?? null},
             ${i})
        `;
      }
    }

    log.info('Purchase order updated', { id, status, total }, 'accounting');

    const newItems = await sql`
      SELECT * FROM po_items WHERE purchase_order_id = ${id}::UUID ORDER BY sort_order
    ` as Row[];

    return apiResponse.success(res, { ...updated[0], items: newItems });
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    // Fast refusal only. The status can change before the DELETE below, which
    // carries the same check in its WHERE (R-129). po_items go by FK cascade.
    const existing = await readStatus(id, companyId);
    if (existing === null) return apiResponse.notFound(res, 'Purchase order', id);
    if (existing !== 'draft') return refuseDelete(res, existing);

    const deleted = await sql`
      DELETE FROM purchase_orders
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
      RETURNING id
    ` as Row[];

    if (deleted.length === 0) {
      const now = await readStatus(id, companyId);
      if (now === null) return apiResponse.notFound(res, 'Purchase order', id);
      // A draft again by the time of this read: the caller's view is stale.
      if (now === 'draft') {
        return apiResponse.conflict(res, 'The purchase order changed while deleting; reload and try again');
      }
      return refuseDelete(res, now);
    }

    log.info('Purchase order deleted', { id }, 'accounting');
    return apiResponse.success(res, { deleted: true, id });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
