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
import { EXPORT_ROW_CEILING } from '@/lib/pagination';
import { linkExpiredSql } from './portalLinkCharge';

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
  /** Inclusive invoice_date bounds, YYYY-MM-DD. The caller validates them. */
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
  page?: number;
  /** Rows to skip. Wins over `page` when given — the MCP tool pages by offset. */
  offset?: number;
}

/**
 * The list's WHERE clause: the tenant scope first, then every optional filter
 * as a typed `${x}::type IS NULL OR ...` predicate, so one parameterised query
 * serves every combination (BL-23). The list, its count and the CSV export all
 * use this one fragment, which is what keeps them from disagreeing.
 *
 * `clientId` narrows within `companyId`; it never replaces it.
 */
function customerInvoiceListWhere(companyId: string, filters: CustomerInvoiceListFilters) {
  const { status = null, clientId = null, search = null, agingFilters = [], dateFrom = null, dateTo = null } = filters;

  const statusValues: string[] | null = status && status.length > 0 ? status : null;
  const clientIdFilter: string | null = clientId && clientId.trim() ? clientId.trim() : null;
  const searchTermFilter: string | null = search && search.trim() ? search.trim() : null;
  const filterDueSoon = agingFilters.includes('due-soon');
  const filterOverdue90 = agingFilters.includes('overdue-90');
  const filterViewedUnpaid = agingFilters.includes('viewed-unpaid');

  return sql`
    ci.company_id = ${companyId}::UUID
    AND ci.deleted_at IS NULL
    AND (${statusValues}::text[] IS NULL OR ci.status = ANY(${statusValues}::text[]))
    AND (${clientIdFilter}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter}::uuid)
    AND (
      ${searchTermFilter}::text IS NULL
      OR ci.invoice_number ILIKE '%' || ${searchTermFilter}::text || '%'
      OR c.name ILIKE '%' || ${searchTermFilter}::text || '%'
    )
    AND (${dateFrom}::date IS NULL OR ci.invoice_date >= ${dateFrom}::date)
    AND (${dateTo}::date IS NULL OR ci.invoice_date <= ${dateTo}::date)
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
  `;
}

export async function listCustomerInvoices(
  companyId: string,
  filters: CustomerInvoiceListFilters = {},
): Promise<{ invoices: Row[]; total: number }> {
  const { limit, page, offset: offsetRaw } = filters;

  // Cap at 100 — aligns with BL-11 / BL-24 limit policy.
  // Sanitise: NaN / negative values from the caller become safe defaults,
  // same as the route did before extraction.
  const safeLimit = Number.isFinite(limit) && (limit as number) > 0 ? Math.min(Math.floor(limit as number), 100) : 25;
  const safePage = Number.isFinite(page) && (page as number) >= 1 ? Math.floor(page as number) : 1;
  const offset = Number.isInteger(offsetRaw) && (offsetRaw as number) >= 0
    ? (offsetRaw as number)
    : (safePage - 1) * safeLimit;

  const where = customerInvoiceListWhere(companyId, filters);

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
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
      LEFT JOIN current_company_invoice_view_summary() vs
        ON vs.customer_invoice_id = ci.id AND vs.company_id = ci.company_id
      WHERE ${where}
      -- id breaks ties: dozens of invoices share a date, and without a total
      -- order OFFSET pages can skip or repeat them.
      ORDER BY ci.invoice_date DESC, ci.id DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    sql`
      SELECT COUNT(*) AS total
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
      LEFT JOIN current_company_invoice_view_summary() vs
        ON vs.customer_invoice_id = ci.id AND vs.company_id = ci.company_id
      WHERE ${where}
    `,
  ]);

  const total = Number(countResult[0]?.total ?? 0);
  return { invoices: invoices as Row[], total };
}

/**
 * Every invoice the list would show for these filters, for CSV export, newest
 * first. Capped at `rowLimit`; the route asks for one row over its ceiling so
 * it can tell the user the export was truncated.
 */
export async function exportCustomerInvoices(
  companyId: string,
  filters: CustomerInvoiceListFilters,
  rowLimit = EXPORT_ROW_CEILING + 1,
): Promise<Row[]> {
  const where = customerInvoiceListWhere(companyId, filters);
  return (await sql`
    SELECT ci.invoice_number, c.name AS client_name,
      ci.total_amount, ci.amount_paid, ci.status,
      to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date,
      to_char(ci.due_date, 'YYYY-MM-DD') AS due_date, NULL AS project_name
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    LEFT JOIN current_company_invoice_view_summary() vs
      ON vs.customer_invoice_id = ci.id AND vs.company_id = ci.company_id
    WHERE ${where}
    ORDER BY ci.invoice_date DESC, ci.id DESC
    LIMIT ${rowLimit}
  `) as Row[];
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
           EXISTS (SELECT 1 FROM portal_payment_links l
                   WHERE l.invoice_id = ci.id AND l.status = 'active' AND l.charges_balance
                     AND NOT ${linkExpiredSql()}) AS has_standing_link,
           ci.currency_code, ci.exchange_rate, ci.functional_total,
           to_char(ci.billing_period_start, 'YYYY-MM-DD') AS billing_period_start,
           to_char(ci.billing_period_end, 'YYYY-MM-DD') AS billing_period_end,
           ci.created_at, ci.updated_at,
           c.name AS client_name, c.email AS client_email
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}
  `) as Row[];
  if (rows.length === 0) return null;

  const items = (await sql`
    SELECT cii.*,
           a.account_code AS gl_account_code, a.account_name AS gl_account_name,
           p.project_number, p.name AS line_project_name,
           c1.code AS cc1_code, c1.name AS cc1_name, c2.code AS cc2_code, c2.name AS cc2_name,
           bu.code AS bu_code, bu.name AS bu_name,
           -- Posted invoices only: did its journal actually credit this line's account? An invoice posted
           -- before migration 874 credited default_revenue whatever account its line names.
           CASE WHEN ci.gl_journal_entry_id IS NULL OR cii.gl_account_id IS NULL THEN NULL
                ELSE EXISTS (SELECT 1 FROM gl_journal_lines jl
                             WHERE jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
                               AND jl.gl_account_id = cii.gl_account_id) END AS account_posted
    FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
    -- Each scoped to the invoice's company: a line naming another company's id
    -- (refused on write, but forgeable) shows no name rather than theirs.
    LEFT JOIN gl_accounts a ON a.id = cii.gl_account_id AND a.company_id = ci.company_id
    LEFT JOIN projects p ON p.id = cii.project_id AND p.company_id = ci.company_id
    LEFT JOIN cost_centres c1 ON c1.id = cii.cc1_id AND c1.company_id = ci.company_id
    LEFT JOIN cost_centres c2 ON c2.id = cii.cc2_id AND c2.company_id = ci.company_id
    LEFT JOIN business_units bu ON bu.id = cii.bu_id AND bu.company_id = ci.company_id
    WHERE cii.invoice_id = ${invoiceId}::UUID AND ci.company_id = ${companyId} ORDER BY cii.created_at
  `) as Row[];

  return { ...rows[0], items };
}
