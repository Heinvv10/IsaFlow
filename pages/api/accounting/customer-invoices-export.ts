/**
 * Customer Invoices Export API
 * GET — export customer invoices as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';
import { EXPORT_ROW_CEILING } from '@/lib/pagination';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const { status } = req.query;

    let rows;
    if (status && status !== 'all') {
      rows = await sql`
        SELECT ci.invoice_number, c.name AS client_name,
          ci.total_amount, ci.amount_paid, ci.status,
          to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          to_char(ci.due_date, 'YYYY-MM-DD') AS due_date, NULL as project_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = ci.client_id
        WHERE ci.company_id = ${companyId}
          AND ci.status = ${status as string}
        ORDER BY ci.invoice_date DESC
        LIMIT ${EXPORT_ROW_CEILING + 1}
      `;
    } else {
      rows = await sql`
        SELECT ci.invoice_number, c.name AS client_name,
          ci.total_amount, ci.amount_paid, ci.status,
          to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          to_char(ci.due_date, 'YYYY-MM-DD') AS due_date, NULL as project_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = ci.client_id
        WHERE ci.company_id = ${companyId}
        ORDER BY ci.invoice_date DESC
        LIMIT ${EXPORT_ROW_CEILING + 1}
      `;
    }

    // P3.4: cap the export rather than paginate — the extra row (if present)
    // is dropped and replaced with a truncation marker row.
    const truncated = rows.length > EXPORT_ROW_CEILING;
    const pageRows = truncated ? rows.slice(0, EXPORT_ROW_CEILING) : rows;

    const csvLines = [
      'Invoice #,Client,Project,Date,Due Date,Amount,Paid,Outstanding,Status',
      ...pageRows.map((r: Record<string, unknown>) => {
        const total = Number(r.total_amount || 0);
        const paid = Number(r.amount_paid || 0);
        return [
          csvCell(String(r.invoice_number)),
          csvCell(String(r.client_name || '')),
          csvCell(String(r.project_name || '')),
          // DATE columns arrive pre-serialized via to_char — String(pg Date)
          // would emit "Sat Jul 04 2026 … GMT+0200 …" into the CSV (PR #194 LOW).
          csvCell(String(r.invoice_date || '')),
          csvCell(String(r.due_date || '')),
          total.toFixed(2),
          paid.toFixed(2),
          (total - paid).toFixed(2),
          csvCell(String(r.status)),
        ].join(',');
      }),
    ];
    if (truncated) {
      csvLines.push([
        csvCell(`TRUNCATED — export capped at ${EXPORT_ROW_CEILING} rows; narrow the date range`),
        ...Array(8).fill(csvCell(undefined)),
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="customer-invoices-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Customer invoices export failed', { error: err });
    return apiResponse.internalError(res, err, 'Failed to export customer invoices');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
