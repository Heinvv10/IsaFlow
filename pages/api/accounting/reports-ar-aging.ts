/**
 * AR Age Analysis Report API
 * GET /api/accounting/reports-ar-aging
 *   ?as_at_date=YYYY-MM-DD  - optional, defaults to today
 *
 * Returns flat invoice rows with bucket classification + summary totals per bucket.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

interface ARAgingRow {
  id: string;
  customer_name: string;
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

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const asAtRaw = req.query.as_at_date ? String(req.query.as_at_date) : null;
    const asAt = asAtRaw ? new Date(asAtRaw) : new Date();
    const asAtStr = asAt.toISOString().split('T')[0] as string;

    const rows = (await sql`
      SELECT
        ci.id,
        c.name                                       AS customer_name,
        ci.invoice_number,
        ci.invoice_date::text                        AS invoice_date,
        ci.due_date::text                            AS due_date,
        ci.total_amount,
        ci.amount_paid,
        (ci.total_amount - ci.amount_paid)           AS balance_due,
        GREATEST(0, (${asAtStr}::date - ci.due_date)) AS days_overdue
      FROM customer_invoices ci
      JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      WHERE ci.company_id = ${companyId}
        AND ci.status NOT IN ('paid', 'cancelled', 'draft')
        AND (ci.total_amount - ci.amount_paid) > 0
        AND ci.due_date IS NOT NULL
      ORDER BY ci.due_date
    `) as Row[];

    const invoiceRows: ARAgingRow[] = rows.map((r: Row) => {
      const daysOverdue = Number(r.days_overdue);
      return {
        id: String(r.id),
        customer_name: String(r.customer_name),
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
    log.error('Failed to get AR aging report', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed to get AR aging report');
  }
}

export default withAuth(
  withErrorHandler(
    withFlowMeter('report.age', getFlowCost('report.age'))(handler),
  ),
);
