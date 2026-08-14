/**
 * Customer Communication Report API
 * GET /api/accounting/reports/customer-communication
 * Supports: customer_id, from, to, status, page, limit, format=csv
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { csvCell } from '@/lib/csv';

interface EmailLogRow {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  email: string;
  email_type: string;
  subject: string;
  sent_at: Date | string;
  status: string;
}

function fmtDate(val: Date | string | null | undefined): string {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

export function buildCsvRow(fields: string[]): string {
  return fields.map(f => csvCell(f)).join(',');
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const {
    customer_id,
    from: fromParam,
    to: toParam,
    status,
    page: pageParam = '1',
    limit: limitParam = '50',
    format,
  } = req.query;

  const isCsv = format === 'csv';
  const limit = isCsv ? 5000 : Math.min(Number(limitParam), 200);
  const page = Math.max(1, Number(pageParam));
  const offset = (page - 1) * limit;

  const customerIdVal = typeof customer_id === 'string' && customer_id ? customer_id : null;
  const fromVal = typeof fromParam === 'string' && fromParam ? fromParam : null;
  const toVal = typeof toParam === 'string' && toParam ? toParam : null;
  const statusVal = typeof status === 'string' && status ? status : null;

  try {
    const rows = (await sql`
      SELECT
        el.id,
        c.id               AS customer_id,
        c.name             AS customer_name,
        el.recipient_email AS email,
        el.email_type,
        el.subject,
        el.sent_at,
        el.status
      FROM email_log el
      LEFT JOIN customers c
        ON LOWER(c.email) = LOWER(el.recipient_email)
       AND c.company_id = ${companyId}
      WHERE el.company_id = ${companyId}
        AND (${customerIdVal}::UUID IS NULL OR c.id = ${customerIdVal}::UUID)
        AND (${fromVal}::DATE IS NULL   OR el.sent_at::DATE >= ${fromVal}::DATE)
        AND (${toVal}::DATE IS NULL     OR el.sent_at::DATE <= ${toVal}::DATE)
        AND (${statusVal}::TEXT IS NULL OR el.status = ${statusVal})
      ORDER BY el.sent_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as EmailLogRow[];

    const countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM email_log el
      LEFT JOIN customers c
        ON LOWER(c.email) = LOWER(el.recipient_email)
       AND c.company_id = ${companyId}
      WHERE el.company_id = ${companyId}
        AND (${customerIdVal}::UUID IS NULL OR c.id = ${customerIdVal}::UUID)
        AND (${fromVal}::DATE IS NULL   OR el.sent_at::DATE >= ${fromVal}::DATE)
        AND (${toVal}::DATE IS NULL     OR el.sent_at::DATE <= ${toVal}::DATE)
        AND (${statusVal}::TEXT IS NULL OR el.status = ${statusVal})
    `) as { cnt: string }[];

    const total = Number(countRows[0]?.cnt ?? 0);

    const records = rows.map(r => ({
      id: r.id,
      customerId: r.customer_id ?? null,
      customerName: r.customer_name ?? r.email,
      email: r.email,
      documentType: r.email_type,
      subject: r.subject,
      sentAt: fmtDate(r.sent_at),
      status: r.status,
    }));

    if (isCsv) {
      const header = buildCsvRow(['Customer', 'Email', 'Document Type', 'Subject', 'Sent At', 'Status']);
      const csvRows = records.map(r =>
        buildCsvRow([r.customerName, r.email, r.documentType, r.subject, r.sentAt, r.status])
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="customer-communication.csv"');
      return res.status(200).send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, { records, total, page, limit });
  } catch (err) {
    log.error('Failed to load customer communication report', { error: err }, 'reports-customer-communication');
    return apiResponse.internalError(res, 'Failed to load customer communication report');
  }
}

export default withAuth(withErrorHandler(handler));
