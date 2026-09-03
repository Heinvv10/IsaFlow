/**
 * AR Aging Report Service — the buckets the UI renders.
 *
 * Rewritten to read `getARSubledger` rather than issue its own query. The old
 * query carried `AND ci.due_date IS NOT NULL` in its WHERE clause and dropped a
 * R1,058,000 invoice from the report with no error and no count (FINDINGS §4).
 * The subledger service keeps that row and labels it unageable; the buckets
 * here cover the ageable documents only, which is the same figure the report
 * always meant to show — the difference is that the omission is now visible,
 * through `getAgingReport` and `aged_debtors`.
 *
 * Bucketing itself is `bucketsForSnapshot`, shared with the MCP report, so the
 * two cannot drift.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { calculateAgingBuckets } from '../../utils/aging';
import type { AgingBucket, AgingInvoice } from '../../types/ap.types';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { getOpenDisputeTotals } from './disputeService';
import { getARSubledger } from './arSubledgerService';
import { bucketsForSnapshot } from '../reports/agingReportService';

type Row = DbRow;

export async function getARAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ?? fmtDate(new Date());
    if (asAtDate && Number.isNaN(new Date(asAtDate).getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    const snapshot = await getARSubledger(companyId, asAt);
    return bucketsForSnapshot(snapshot, snapshot.disputes, asAt);
  } catch (err) {
    log.error('Failed to get AR aging', { error: err }, 'accounting');
    throw err;
  }
}

export async function getARAgingDetail(companyId: string,
  clientId: string,
  asAtDate?: string
): Promise<{ client: { id: string; name: string }; invoices: AgingInvoice[]; buckets: AgingBucket | null }> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();

    const clientRows = (await sql`SELECT id, name AS name FROM customers WHERE id = ${clientId}::UUID AND company_id = ${companyId}`) as Row[];
    if (clientRows.length === 0) throw new Error(`Client ${clientId} not found`);

    const rows = (await sql`
      SELECT ci.id, COALESCE(ci.client_id, ci.customer_id) AS entity_id, c.name AS entity_name,
        ci.due_date, ci.invoice_number, ci.total_amount, ci.amount_paid,
        (ci.total_amount - ci.amount_paid) AS balance
      FROM customer_invoices ci
      JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      WHERE ci.company_id = ${companyId}
        AND COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID
        AND ci.status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
        AND (ci.total_amount - ci.amount_paid) > 0
        AND ci.due_date IS NOT NULL
      ORDER BY ci.due_date
    `) as Row[];

    const invoiceIds = rows.map((r: Row) => String(r.id));
    const disputedTotals = await getOpenDisputeTotals(companyId, invoiceIds);

    const invoices: AgingInvoice[] = rows.map((r: Row) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      entityName: String(r.entity_name),
      dueDate: String(r.due_date),
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
      disputedAmount: disputedTotals.get(String(r.id)) ?? 0,
    }));

    const buckets = calculateAgingBuckets(invoices, asAt);
    return {
      client: { id: String(clientRows[0]!.id), name: String(clientRows[0]!.name) },
      invoices,
      buckets: buckets.length > 0 ? buckets[0]! : null,
    };
  } catch (err) {
    log.error('Failed to get AR aging detail', { clientId, error: err }, 'accounting');
    throw err;
  }
}
