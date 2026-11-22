/**
 * Supplier POs by Supplier Report API
 * GET /api/accounting/reports-supplier-pos
 *   ?status=draft|submitted|approved|partially_received|received|closed|cancelled (retired sent -> approved; invoiced,
 *    partially_invoiced or an unknown status -> 400)
 *   &date_from=YYYY-MM-DD
 *   &date_to=YYYY-MM-DD
 *
 * Returns purchase orders grouped by supplier with totals. Reads the canonical purchase_orders (migration 1022 copied
 * every supplier_purchase_orders row into it under the same id, with the same figures).
 * Sage Accounting parity: Suppliers > Reports > Purchase Orders by Supplier
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import sql from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { reportStatusFilter } from '@/modules/accounting/services/ap/supplierPoReportStatus';

export interface SupplierPoRow {
  id: string;
  orderNumber: string;
  orderDate: string;
  deliveryDate: string | null;
  reference: string | null;
  status: string;
  totalAmount: number;
  taxAmount: number;
  subtotal: number;
}

export interface SupplierPoGroup {
  supplierId: string;
  supplierName: string;
  poCount: number;
  totalValue: number;
  pos: SupplierPoRow[];
}

export interface SupplierPosReportResponse {
  suppliers: SupplierPoGroup[];
  grandTotal: number;
  grandPoCount: number;
}

function toDateString(val: Date | string | null | undefined): string | null {
  if (!val) return null;
  return fmtDate(val);
}

async function getSupplierPosReport(
  companyId: string,
  status: string | null,
  dateFrom: string | null,
  dateTo: string | null,
): Promise<SupplierPosReportResponse> {
  const statusFilter = status ?? null;
  const fromFilter = dateFrom ?? null;
  const toFilter = dateTo ?? null;

  const rows = await sql`
    SELECT
      po.id,
      po.po_number,
      po.order_date,
      po.expected_delivery_date,
      po.reference,
      po.status,
      po.total,
      po.tax_amount,
      po.subtotal,
      po.supplier_id,
      COALESCE(s.name, 'Unknown Supplier') AS supplier_name
    FROM purchase_orders po
    LEFT JOIN suppliers s
      ON s.id = po.supplier_id
      AND s.company_id = po.company_id
    WHERE po.company_id = ${companyId}::UUID
      AND (${statusFilter}::TEXT IS NULL OR po.status = ${statusFilter})
      AND (${fromFilter}::DATE IS NULL OR po.order_date >= ${fromFilter}::DATE)
      AND (${toFilter}::DATE IS NULL OR po.order_date <= ${toFilter}::DATE)
    ORDER BY supplier_name ASC, po.order_date DESC
  `;

  // Group by supplier in application layer
  const supplierMap = new Map<string, SupplierPoGroup>();

  for (const row of rows) {
    const supplierId = String(row.supplier_id ?? 'unknown');
    const supplierName = String(row.supplier_name);

    if (!supplierMap.has(supplierId)) {
      supplierMap.set(supplierId, {
        supplierId,
        supplierName,
        poCount: 0,
        totalValue: 0,
        pos: [],
      });
    }

    const group = supplierMap.get(supplierId)!;
    const totalAmount = Number(row.total ?? 0);

    group.poCount += 1;
    group.totalValue = Math.round((group.totalValue + totalAmount) * 100) / 100;
    group.pos.push({
      id: String(row.id),
      orderNumber: String(row.po_number),
      orderDate: toDateString(row.order_date as Date | string) ?? '',
      deliveryDate: toDateString(row.expected_delivery_date as Date | string | null),
      reference: row.reference ? String(row.reference) : null,
      status: String(row.status),
      totalAmount,
      taxAmount: Number(row.tax_amount ?? 0),
      subtotal: Number(row.subtotal ?? 0),
    });
  }

  const suppliers = Array.from(supplierMap.values());
  const grandTotal = Math.round(suppliers.reduce((s, g) => s + g.totalValue, 0) * 100) / 100;
  const grandPoCount = suppliers.reduce((s, g) => s + g.poCount, 0);

  return { suppliers, grandTotal, grandPoCount };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { status, date_from, date_to } = req.query;

  // A retired SPO status is translated or refused, never compared literally into an empty report (Codex gate).
  const filter = reportStatusFilter(status && typeof status === 'string' ? status : null);
  if ('refusal' in filter) return apiResponse.badRequest(res, filter.refusal);
  const statusVal = filter.status;
  const dateFromVal = date_from && typeof date_from === 'string' ? date_from : null;
  const dateToVal = date_to && typeof date_to === 'string' ? date_to : null;

  try {
    const report = await getSupplierPosReport(companyId, statusVal, dateFromVal, dateToVal);
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Supplier POs report failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate supplier POs report');
  }
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
