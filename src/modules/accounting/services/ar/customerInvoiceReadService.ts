/**
 * Customer Invoice Read Service
 *
 * List + detail queries extracted from customer-invoices-list.ts and
 * customer-invoices-detail.ts (GET branch) so the MCP read-tool layer can
 * call the exact same functions the API routes use. SQL text and parameter
 * semantics are unchanged from the routes; only request-specific
 * query-string parsing (status array normalisation, ?aging= parsing,
 * ?q= trimming) stays in the routes and is passed in as plain filter values.
 */

import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

/**
 * 'due-soon'   — due_date between today and today+7 (unpaid)
 * 'overdue-90' — days_overdue > 90
 * 'viewed-unpaid' — sent + last_viewed_at IS NOT NULL
 */
export interface CustomerInvoiceListFilters {
  status?: string[] | null;
  clientId?: string | null;
  search?: string | null;
  agingFilters?: Array<'due-soon' | 'overdue-90' | 'viewed-unpaid'>;
  limit?: number;
  page?: number;
}

export async function listCustomerInvoices(
  companyId: string,
  filters: CustomerInvoiceListFilters = {},
): Promise<{ invoices: Row[]; total: number }> {
  const {
    status = null,
    clientId = null,
    search = null,
    agingFilters = [],
    limit,
    page,
  } = filters;

  // Cap at 100 — aligns with BL-11 / BL-24 limit policy.
  // Sanitise: NaN / negative values from the caller become safe defaults,
  // same as the route did before extraction.
  const safeLimit = Number.isFinite(limit) && (limit as number) > 0 ? Math.min(Math.floor(limit as number), 100) : 25;
  const safePage = Number.isFinite(page) && (page as number) >= 1 ? Math.floor(page as number) : 1;
  const offset = (safePage - 1) * safeLimit;

  const statusValues: string[] | null = status && status.length > 0 ? status : null;
  const clientIdFilter: string | null = clientId && clientId.trim() ? clientId.trim() : null;
  const searchTermFilter: string | null = search && search.trim() ? search.trim() : null;

  const filterDueSoon = agingFilters.includes('due-soon');
  const filterOverdue90 = agingFilters.includes('overdue-90');
  const filterViewedUnpaid = agingFilters.includes('viewed-unpaid');

  const [invoices, countResult] = await Promise.all([
    sql`
      SELECT
        ci.id,
        ci.invoice_number,
        ci.project_id,
        COALESCE(ci.client_id, ci.customer_id) AS client_id,
        ci.total_amount,
        ci.amount_paid,
        ci.status,
        to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date,
        to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
        ci.sent_at,
        ci.paid_at,
        ci.currency_code,
        ci.exchange_rate,
        ci.functional_total,
        c.name AS client_name,
        vs.last_viewed_at,
        COALESCE(vs.view_count, 0) AS view_count,
        CASE
          WHEN ci.due_date IS NOT NULL AND ci.status != 'paid'
            THEN GREATEST(0, (CURRENT_DATE - ci.due_date::date))
          ELSE NULL
        END AS days_overdue,
        CASE
          WHEN ci.status = 'paid' THEN NULL
          WHEN ci.due_date IS NULL THEN 'Current'
          WHEN (CURRENT_DATE - ci.due_date::date) <= 0 THEN 'Current'
          WHEN (CURRENT_DATE - ci.due_date::date) <= 30 THEN '1-30'
          WHEN (CURRENT_DATE - ci.due_date::date) <= 60 THEN '31-60'
          WHEN (CURRENT_DATE - ci.due_date::date) <= 90 THEN '61-90'
          ELSE '90+'
        END AS aging_bucket
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      LEFT JOIN customer_invoice_view_summary vs
        ON vs.customer_invoice_id = ci.id AND vs.company_id = ci.company_id
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.deleted_at IS NULL
        AND (${statusValues}::text[] IS NULL OR ci.status = ANY(${statusValues}::text[]))
        AND (${clientIdFilter}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter}::uuid)
        AND (
          ${searchTermFilter}::text IS NULL
          OR ci.invoice_number ILIKE '%' || ${searchTermFilter}::text || '%'
          OR c.name ILIKE '%' || ${searchTermFilter}::text || '%'
        )
        AND (NOT ${filterDueSoon} OR (
          ci.status != 'paid'
          AND ci.due_date IS NOT NULL
          AND ci.due_date::date >= CURRENT_DATE
          AND ci.due_date::date <= CURRENT_DATE + INTERVAL '7 days'
        ))
        AND (NOT ${filterOverdue90} OR (
          ci.status != 'paid'
          AND ci.due_date IS NOT NULL
          AND (CURRENT_DATE - ci.due_date::date) > 90
        ))
        AND (NOT ${filterViewedUnpaid} OR (
          ci.status = 'sent'
          AND vs.last_viewed_at IS NOT NULL
        ))
      ORDER BY ci.invoice_date DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    sql`
      SELECT COUNT(*) AS total
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      LEFT JOIN customer_invoice_view_summary vs
        ON vs.customer_invoice_id = ci.id AND vs.company_id = ci.company_id
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.deleted_at IS NULL
        AND (${statusValues}::text[] IS NULL OR ci.status = ANY(${statusValues}::text[]))
        AND (${clientIdFilter}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter}::uuid)
        AND (
          ${searchTermFilter}::text IS NULL
          OR ci.invoice_number ILIKE '%' || ${searchTermFilter}::text || '%'
          OR c.name ILIKE '%' || ${searchTermFilter}::text || '%'
        )
        AND (NOT ${filterDueSoon} OR (
          ci.status != 'paid'
          AND ci.due_date IS NOT NULL
          AND ci.due_date::date >= CURRENT_DATE
          AND ci.due_date::date <= CURRENT_DATE + INTERVAL '7 days'
        ))
        AND (NOT ${filterOverdue90} OR (
          ci.status != 'paid'
          AND ci.due_date IS NOT NULL
          AND (CURRENT_DATE - ci.due_date::date) > 90
        ))
        AND (NOT ${filterViewedUnpaid} OR (
          ci.status = 'sent'
          AND vs.last_viewed_at IS NOT NULL
        ))
    `,
  ]);

  const total = Number(countResult[0]?.total ?? 0);
  return { invoices: invoices as Row[], total };
}

export async function getCustomerInvoiceDetail(companyId: string, invoiceId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT ci.id, ci.invoice_number, ci.customer_id, ci.client_id,
           ci.subtotal, ci.tax_rate, ci.tax_amount, ci.total_amount,
           ci.amount_paid, ci.status,
           to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date,
           to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
           ci.sent_at, ci.paid_at, ci.notes, ci.internal_notes,
           ci.project_id, ci.gl_journal_entry_id,
           ci.email_sent_at, ci.email_sent_to,
           ci.online_payment_enabled, ci.payment_url,
           ci.currency_code, ci.exchange_rate, ci.functional_total,
           to_char(ci.billing_period_start, 'YYYY-MM-DD') AS billing_period_start,
           to_char(ci.billing_period_end, 'YYYY-MM-DD') AS billing_period_end,
           ci.created_at, ci.updated_at,
           c.name AS client_name, c.email AS client_email
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}
  `) as Row[];
  if (rows.length === 0) return null;

  const items = (await sql`
    SELECT cii.* FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id WHERE cii.invoice_id = ${invoiceId}::UUID AND ci.company_id = ${companyId} ORDER BY cii.created_at
  `) as Row[];

  return { ...rows[0], items };
}
