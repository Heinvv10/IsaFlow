/**
 * Purchases by Supplier Report API
 * GET: Returns purchase summary grouped by supplier for a date range
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { rewindAmount, effectivePaidExpr } from '@/modules/accounting/services/shared/agingRewind';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  try {
    // fmtDate, not toISOString: "to" is now the date the balances are rewound
    // to, and on this UTC+2 host toISOString names YESTERDAY from 00:00 to 02:00.
    const from = (typeof req.query.from === 'string' ? req.query.from : null) || fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const to = (typeof req.query.to === 'string' ? req.query.to : null) || fmtDate(new Date());
    const format = typeof req.query.format === 'string' ? req.query.format : undefined;

    const { companyId } = req as CompanyAuthedRequest;
    const paid = effectivePaidExpr('ap');
    const rows = await sql`
      SELECT
        si.supplier_id,
        COALESCE(s.name, s.company_name) AS supplier_name,
        COUNT(si.id)::int AS invoice_count,
        COALESCE(SUM(si.total_amount), 0)::numeric AS total_purchases,
        COALESCE(SUM(${sql.unsafe(paid)}), 0)::numeric AS payments_made,
        COALESCE(SUM(si.total_amount - ${sql.unsafe(paid)}), 0)::numeric AS outstanding
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: to, todayStr: fmtDate(new Date()), side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}
        -- AS AT "to", drafts excluded, the aged report's own rewind: the bills
        -- raised in the period and their standing on the period end, not the
        -- ageing's total. See sales-by-customer (R-059).
        AND ${documentInLedgerAsAtFragment('si', to ?? asAtTodayStr(), companyId)}
        AND si.invoice_date >= ${from}
        AND si.invoice_date <= ${to}
        AND si.status NOT IN ('draft', 'cancelled')
      GROUP BY si.supplier_id, s.name, s.company_name
      ORDER BY total_purchases DESC
    `;

    const data = rows.map(r => ({
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      invoiceCount: Number(r.invoice_count),
      totalPurchases: Number(r.total_purchases),
      paymentsMade: Number(r.payments_made),
      outstanding: Number(r.outstanding),
    }));

    if (format === 'csv') {
      const header = 'Supplier,Invoices,Total Purchases,Paid,Outstanding';
      const csvRows = data.map(r =>
        `${csvCell(r.supplierName)},${r.invoiceCount},${r.totalPurchases.toFixed(2)},${r.paymentsMade.toFixed(2)},${r.outstanding.toFixed(2)}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="purchases-by-supplier-${from}-${to}.csv"`);
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('purchases-by-supplier report error', { error: message });
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, 'Failed to generate report');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
