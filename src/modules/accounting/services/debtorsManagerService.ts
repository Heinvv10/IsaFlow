/**
 * Debtors Manager Service
 * Sage-parity collections/aging dashboard for AR
 *
 * Queries customer_invoices and customer_payments (existing tables).
 * No new migration required.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DebtorSummary {
  clientId: string;
  clientName: string;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days90Plus: number;
  totalOutstanding: number;
  invoiceCount: number;
}

export interface DebtorInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  totalAmount: number;
  amountPaid: number;
  outstanding: number;
  daysOverdue: number;
  status: string;
  agingBucket: 'current' | 'days30' | 'days60' | 'days90' | 'days90Plus';
}

export interface OverdueInvoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: number;
  amountPaid: number;
  outstanding: number;
  daysOverdue: number;
  status: string;
}

export interface CollectionStats {
  totalOutstanding: number;
  totalOverdue: number;
  avgDaysOutstanding: number;
  collectionRate: number;
  clientCount: number;
  overdueCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyBucket(daysOverdue: number): DebtorInvoice['agingBucket'] {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'days30';
  if (daysOverdue <= 60) return 'days60';
  if (daysOverdue <= 90) return 'days90';
  return 'days90Plus';
}

// ── Debtors Summary ───────────────────────────────────────────────────────────

/**
 * Aggregate outstanding invoices by customer with aging buckets.
 * Buckets: current (not yet due), 1-30, 31-60, 61-90, 90+ days overdue.
 */
export async function getDebtorsSummary(): Promise<DebtorSummary[]> {
  try {
    const rows = (await sql`
      SELECT
        ci.client_id,
        c.company_name AS client_name,
        COUNT(ci.id)::int AS invoice_count,
        SUM(
          CASE WHEN ci.due_date IS NULL OR ci.due_date >= CURRENT_DATE
               THEN (ci.total_amount - ci.amount_paid) ELSE 0 END
        ) AS current,
        SUM(
          CASE WHEN ci.due_date IS NOT NULL
                AND ci.due_date < CURRENT_DATE
                AND (CURRENT_DATE - ci.due_date) <= 30
               THEN (ci.total_amount - ci.amount_paid) ELSE 0 END
        ) AS days30,
        SUM(
          CASE WHEN ci.due_date IS NOT NULL
                AND (CURRENT_DATE - ci.due_date) BETWEEN 31 AND 60
               THEN (ci.total_amount - ci.amount_paid) ELSE 0 END
        ) AS days60,
        SUM(
          CASE WHEN ci.due_date IS NOT NULL
                AND (CURRENT_DATE - ci.due_date) BETWEEN 61 AND 90
               THEN (ci.total_amount - ci.amount_paid) ELSE 0 END
        ) AS days90,
        SUM(
          CASE WHEN ci.due_date IS NOT NULL
                AND (CURRENT_DATE - ci.due_date) > 90
               THEN (ci.total_amount - ci.amount_paid) ELSE 0 END
        ) AS days90_plus,
        SUM(ci.total_amount - ci.amount_paid) AS total_outstanding
      FROM customer_invoices ci
      JOIN clients c ON c.id = ci.client_id
      WHERE ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
        AND (ci.total_amount - ci.amount_paid) > 0
      GROUP BY ci.client_id, c.company_name
      ORDER BY total_outstanding DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      clientId: String(r.client_id),
      clientName: String(r.client_name),
      current: Number(r.current),
      days30: Number(r.days30),
      days60: Number(r.days60),
      days90: Number(r.days90),
      days90Plus: Number(r.days90_plus),
      totalOutstanding: Number(r.total_outstanding),
      invoiceCount: Number(r.invoice_count),
    }));
  } catch (err) {
    log.error('getDebtorsSummary failed', { error: err }, 'accounting');
    throw err;
  }
}

// ── Debtor Detail ─────────────────────────────────────────────────────────────

/**
 * List outstanding invoices for a specific customer with age and amounts.
 */
export async function getDebtorDetail(clientId: string): Promise<DebtorInvoice[]> {
  try {
    const rows = (await sql`
      SELECT
        ci.id,
        ci.invoice_number,
        ci.invoice_date,
        ci.due_date,
        ci.total_amount,
        ci.amount_paid,
        (ci.total_amount - ci.amount_paid) AS outstanding,
        ci.status,
        CASE
          WHEN ci.due_date IS NULL THEN 0
          ELSE GREATEST(0, (CURRENT_DATE - ci.due_date)::int)
        END AS days_overdue
      FROM customer_invoices ci
      WHERE ci.client_id = ${clientId}::UUID
        AND ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
        AND (ci.total_amount - ci.amount_paid) > 0
      ORDER BY ci.due_date ASC NULLS LAST, ci.invoice_date ASC
    `) as Row[];

    return rows.map((r: Row) => {
      const daysOverdue = Number(r.days_overdue);
      return {
        id: String(r.id),
        invoiceNumber: String(r.invoice_number),
        invoiceDate: String(r.invoice_date),
        dueDate: r.due_date ? String(r.due_date) : null,
        totalAmount: Number(r.total_amount),
        amountPaid: Number(r.amount_paid),
        outstanding: Number(r.outstanding),
        daysOverdue,
        status: String(r.status),
        agingBucket: classifyBucket(daysOverdue),
      };
    });
  } catch (err) {
    log.error('getDebtorDetail failed', { clientId, error: err }, 'accounting');
    throw err;
  }
}

// ── Overdue Invoices ──────────────────────────────────────────────────────────

/**
 * List all overdue invoices sorted by age descending.
 * Optionally filter to invoices overdue by at least daysOverdue days.
 */
export async function getOverdueInvoices(daysOverdue?: number): Promise<OverdueInvoice[]> {
  const minDays = daysOverdue ?? 1;

  try {
    const rows = (await sql`
      SELECT
        ci.id,
        ci.invoice_number,
        ci.client_id,
        c.company_name AS client_name,
        ci.invoice_date,
        ci.due_date,
        ci.total_amount,
        ci.amount_paid,
        (ci.total_amount - ci.amount_paid) AS outstanding,
        (CURRENT_DATE - ci.due_date)::int AS days_overdue,
        ci.status
      FROM customer_invoices ci
      JOIN clients c ON c.id = ci.client_id
      WHERE ci.due_date IS NOT NULL
        AND ci.due_date < CURRENT_DATE
        AND (CURRENT_DATE - ci.due_date) >= ${minDays}
        AND ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
        AND (ci.total_amount - ci.amount_paid) > 0
      ORDER BY days_overdue DESC, ci.total_amount DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      id: String(r.id),
      invoiceNumber: String(r.invoice_number),
      clientId: String(r.client_id),
      clientName: String(r.client_name),
      invoiceDate: String(r.invoice_date),
      dueDate: String(r.due_date),
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      outstanding: Number(r.outstanding),
      daysOverdue: Number(r.days_overdue),
      status: String(r.status),
    }));
  } catch (err) {
    log.error('getOverdueInvoices failed', { daysOverdue, error: err }, 'accounting');
    throw err;
  }
}

// ── Collection Stats ──────────────────────────────────────────────────────────

/**
 * Aggregate collection metrics: total outstanding, total overdue,
 * average days outstanding, and collection rate.
 */
export async function getCollectionStats(): Promise<CollectionStats> {
  try {
    const rows = (await sql`
      SELECT
        SUM(ci.total_amount - ci.amount_paid)                            AS total_outstanding,
        SUM(CASE WHEN ci.due_date < CURRENT_DATE
                 THEN (ci.total_amount - ci.amount_paid) ELSE 0 END)     AS total_overdue,
        COALESCE(AVG(
          CASE WHEN ci.due_date IS NOT NULL AND ci.due_date < CURRENT_DATE
               THEN (CURRENT_DATE - ci.due_date)::numeric END
        ), 0)                                                             AS avg_days_outstanding,
        COUNT(DISTINCT ci.client_id)::int                                AS client_count,
        COUNT(CASE WHEN ci.due_date < CURRENT_DATE THEN 1 END)::int      AS overdue_count
      FROM customer_invoices ci
      WHERE ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
        AND (ci.total_amount - ci.amount_paid) > 0
    `) as Row[];

    const rateRows = (await sql`
      SELECT
        SUM(ci.total_amount)  AS invoiced,
        SUM(ci.amount_paid)   AS collected
      FROM customer_invoices ci
      WHERE ci.status NOT IN ('draft', 'cancelled')
    `) as Row[];

    const r = rows[0] ?? {};
    const rate = rateRows[0] ?? {};
    const invoiced = Number(rate.invoiced ?? 0);
    const collected = Number(rate.collected ?? 0);

    return {
      totalOutstanding: Number(r.total_outstanding ?? 0),
      totalOverdue: Number(r.total_overdue ?? 0),
      avgDaysOutstanding: Math.round(Number(r.avg_days_outstanding ?? 0)),
      collectionRate: invoiced > 0 ? Math.round((collected / invoiced) * 100 * 10) / 10 : 0,
      clientCount: Number(r.client_count ?? 0),
      overdueCount: Number(r.overdue_count ?? 0),
    };
  } catch (err) {
    log.error('getCollectionStats failed', { error: err }, 'accounting');
    throw err;
  }
}
