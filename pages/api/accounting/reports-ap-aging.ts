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
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { parsePagination } from '@/lib/pagination';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { rewindAmount, effectivePaidExpr } from '@/modules/accounting/services/shared/agingRewind';

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

  const { companyId } = req as CompanyAuthedRequest;
  // P3.4: was unbounded across every open supplier invoice. One row per open
  // invoice, so a generous cap; bucket totals below come from a SQL aggregate
  // over the FULL population so a capped row list can never skew them.
  const { limit, offset } = parsePagination(req.query, 1000, 2000);

  try {
    const asAtRaw = req.query.as_at_date ? String(req.query.as_at_date) : null;
    const asAt = asAtRaw ? new Date(asAtRaw) : new Date();
    // Local date — toISOString() rolls back a day between 00:00–02:00 SAST
    // (UTC+2 server); same fix as reports-ar-aging (P1.4 date family).
    const asAtStr = fmtDate(asAt);
    // The rewind window's upper bound comes from the SAME clock as asAtStr, not
    // from CURRENT_DATE: the session is UTC and the business runs UTC+2, so for
    // two hours nightly CURRENT_DATE is the previous day. Taking both bounds
    // from one clock makes "the window is empty at today" hold by construction.
    const todayStr = fmtDate(new Date());
    const paid = effectivePaidExpr('ap');

    const rows = (await sql`
      SELECT
        si.id,
        s.name                                          AS supplier_name,
        si.invoice_number,
        si.invoice_date::text                           AS invoice_date,
        si.due_date::text                               AS due_date,
        si.total_amount,
        ${sql.unsafe(paid)}                             AS amount_paid,
        (si.total_amount - ${sql.unsafe(paid)})         AS balance_due,
        GREATEST(0, (${asAtStr}::date - COALESCE(si.due_date, si.invoice_date)))  AS days_overdue
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        -- A soft-deleted document leaves this figure exactly when the delete's
        -- GL reversal reaches the ledger, and not one day earlier: the reversal
        -- is dated TODAY whenever the document's own period is closed, so an
        -- undated exclusion drops it from every earlier as-at date while the
        -- control account still carries it. See shared/softDeleteLedgerPresence.
        AND ${documentInLedgerAsAtFragment('si', asAtStr, companyId)}
        -- POINT IN TIME (R-059). as_at_date used to reach only the days_overdue
        -- term: the population was bounded by nothing and the balance came from
        -- si.balance, a STORED GENERATED column over TODAY's amount_paid, so a
        -- past-dated report showed bills raised since and netted off payments
        -- made since. Both bounds now match apAgingService, through the same
        -- shared rewind, so the route and the service cannot drift apart again.
        -- 'paid' leaves the status filter for the same reason: a bill settled
        -- TODAY was outstanding then, and excluding it is what erased settled
        -- debt from historical ageing.
        -- COALESCE: status is NULLABLE and NULL NOT IN (...) is NULL, not TRUE,
        -- so the bare comparison silently DROPPED every null-status invoice —
        -- the under-reporting K-091 fixed on sales-by-customer.
        AND COALESCE(si.status, '') NOT IN ('draft', 'cancelled')
        AND si.invoice_date <= ${asAtStr}::date
        AND (si.total_amount - ${sql.unsafe(paid)}) > 0
      ORDER BY COALESCE(si.due_date, si.invoice_date), si.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `) as Row[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const invoiceRows: APAgingRow[] = page.map((r: Row) => {
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

    // Bucket summary is aggregated in SQL over the FULL open-invoice
    // population (not `page`) so it stays correct regardless of the cap above.
    const bucketRows = (await sql`
      SELECT
        CASE
          WHEN GREATEST(0, (${asAtStr}::date - COALESCE(si.due_date, si.invoice_date))) <= 0 THEN 'current'
          WHEN GREATEST(0, (${asAtStr}::date - COALESCE(si.due_date, si.invoice_date))) <= 30 THEN '1-30'
          WHEN GREATEST(0, (${asAtStr}::date - COALESCE(si.due_date, si.invoice_date))) <= 60 THEN '31-60'
          WHEN GREATEST(0, (${asAtStr}::date - COALESCE(si.due_date, si.invoice_date))) <= 90 THEN '61-90'
          ELSE '90+'
        END AS bucket,
        COUNT(*)::int AS count,
        SUM(si.total_amount - ${sql.unsafe(paid)})::numeric AS total
      FROM supplier_invoices si
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        AND ${documentInLedgerAsAtFragment('si', asAtStr, companyId)}
        -- COALESCE: status is NULLABLE and NULL NOT IN (...) is NULL, not TRUE,
        -- so the bare comparison silently DROPPED every null-status invoice —
        -- the under-reporting K-091 fixed on sales-by-customer.
        AND COALESCE(si.status, '') NOT IN ('draft', 'cancelled')
        AND si.invoice_date <= ${asAtStr}::date
        AND (si.total_amount - ${sql.unsafe(paid)}) > 0
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
    log.error('Failed to get AP aging report', { error: err }, 'accounting-api');
    return apiResponse.badRequestFromError(res, err, 'Failed to get AP aging report');
  }
}

export default withAuth(
  withErrorHandler(
    withFlowMeter('report.age', getFlowCost('report.age'))(handler),
  ),
);
