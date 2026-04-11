/**
 * AP Age Analysis Report API
 * GET /api/accounting/reports-ap-aging
 *   ?as_at_date=YYYY-MM-DD  - optional, defaults to today
 *
 * Returns flat invoice rows with bucket classification + summary totals per bucket.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

interface APAgingRow {
  id: string;
  supplier_name: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  days_overdue: number;
  bucket: Bucket;
}

interface BucketSummary {
  bucket: Bucket;
  count: number;
  total: number;
}

function classifyBucket(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

const BUCKET_ORDER: Bucket[] = ['current', '1-30', '31-60', '61-90', '90+'];

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const asAtRaw = req.query.as_at_date ? String(req.query.as_at_date) : null;
    const asAt = asAtRaw ? new Date(asAtRaw) : new Date();
    const asAtStr = asAt.toISOString().split('T')[0] as string;

    const rows = (await sql`
      SELECT
        si.id,
        s.name                                          AS supplier_name,
        si.invoice_number,
        si.invoice_date::text                           AS invoice_date,
        si.due_date::text                               AS due_date,
        si.total_amount,
        si.amount_paid,
        si.balance                                      AS balance_due,
        GREATEST(0, (${asAtStr}::date - si.due_date))  AS days_overdue
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.company_id = ${companyId}::UUID
        AND si.status NOT IN ('paid', 'cancelled', 'draft')
        AND si.balance > 0
        AND si.due_date IS NOT NULL
      ORDER BY si.due_date
    `) as Row[];

    const invoiceRows: APAgingRow[] = rows.map((r: Row) => {
      const daysOverdue = Number(r.days_overdue);
      return {
        id: String(r.id),
        supplier_name: String(r.supplier_name),
        invoice_number: String(r.invoice_number ?? ''),
        invoice_date: String(r.invoice_date ?? ''),
        due_date: String(r.due_date ?? ''),
        total_amount: Number(r.total_amount),
        amount_paid: Number(r.amount_paid),
        balance_due: Number(r.balance_due),
        days_overdue: daysOverdue,
        bucket: classifyBucket(daysOverdue),
      };
    });

    // Build summary
    const summaryMap = new Map<Bucket, BucketSummary>();
    for (const b of BUCKET_ORDER) {
      summaryMap.set(b, { bucket: b, count: 0, total: 0 });
    }
    for (const row of invoiceRows) {
      const s = summaryMap.get(row.bucket)!;
      s.count += 1;
      s.total += row.balance_due;
    }
    const summary = BUCKET_ORDER.map(b => summaryMap.get(b)!);

    return apiResponse.success(res, { rows: invoiceRows, summary, as_at_date: asAtStr });
  } catch (err) {
    log.error('Failed to get AP aging report', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed to get AP aging report');
  }
}

export default withCompany(withErrorHandler(handler));
