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
import { fmtDate } from '@/lib/fmtDate';
import { parsePagination } from '@/lib/pagination';

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
  // P3.4: was unbounded across every open customer invoice. One row per open
  // invoice, so a generous cap; bucket totals below come from a SQL aggregate
  // over the FULL population so a capped row list can never skew them.
  const { limit, offset } = parsePagination(req.query, 1000, 2000);

  try {
    const asAtRaw = req.query.as_at_date ? String(req.query.as_at_date) : null;
    const asAt = asAtRaw ? new Date(asAtRaw) : new Date();
    // Local date — toISOString() rolls back a day between 00:00–02:00 SAST,
    // shifting invoices across aging buckets (P1.4 sweep).
    const asAtStr = fmtDate(asAt);

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
      ORDER BY ci.due_date, ci.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `) as Row[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const invoiceRows: ARAgingRow[] = page.map((r: Row) => {
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

    // Bucket summary is aggregated in SQL over the FULL open-invoice
    // population (not `page`) so it stays correct regardless of the cap above.
    const bucketRows = (await sql`
      SELECT
        CASE
          WHEN GREATEST(0, (${asAtStr}::date - ci.due_date)) <= 0 THEN 'current'
          WHEN GREATEST(0, (${asAtStr}::date - ci.due_date)) <= 30 THEN '1-30'
          WHEN GREATEST(0, (${asAtStr}::date - ci.due_date)) <= 60 THEN '31-60'
          WHEN GREATEST(0, (${asAtStr}::date - ci.due_date)) <= 90 THEN '61-90'
          ELSE '90+'
        END AS bucket,
        COUNT(*)::int AS count,
        SUM(ci.total_amount - ci.amount_paid)::numeric AS total
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}
        AND ci.status NOT IN ('paid', 'cancelled', 'draft')
        AND (ci.total_amount - ci.amount_paid) > 0
        AND ci.due_date IS NOT NULL
      GROUP BY bucket
    `) as Row[];

    const summaryMap = new Map<Bucket, BucketSummary>();
    for (const b of BUCKET_ORDER) {
      summaryMap.set(b, { bucket: b, count: 0, total: 0 });
    }
    for (const r of bucketRows) {
      const bucket = String(r.bucket) as Bucket;
      const s = summaryMap.get(bucket);
      if (s) {
        s.count = Number(r.count);
        s.total = Number(r.total);
      }
    }
    const summary = BUCKET_ORDER.map(b => summaryMap.get(b)!);

    return apiResponse.success(
      res,
      { rows: invoiceRows, summary, as_at_date: asAtStr },
      undefined, 200, { limit, offset, hasMore },
    );
  } catch (err) {
    log.error('Failed to get AR aging report', { error: err }, 'accounting-api');
    return apiResponse.badRequestFromError(res, err, 'Failed to get AR aging report');
  }
}

export default withAuth(
  withErrorHandler(
    withFlowMeter('report.age', getFlowCost('report.age'))(handler),
  ),
);
