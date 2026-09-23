/**
 * Shared query-param parser for the customer-invoices list and export routes,
 * so the CSV always carries exactly the filters the list shows.
 *
 * The pre-existing params keep the behaviour they had inline in the list
 * route: `status` (single, repeated, or `all`), `q`, `client_id`, `aging`,
 * `limit`/`page` with NaN-safe defaults. The date range is new and strict — a
 * malformed date is a 400, not a silently dropped filter. `client_id` is now
 * shape-checked too: a non-UUID used to reach the `::uuid` cast and 500.
 */

import type { CustomerInvoiceListFilters } from './customerInvoiceReadService';
import { parseInvoiceDateRange } from '../core/invoiceDateRangeParams';

type AgingFilter = NonNullable<CustomerInvoiceListFilters['agingFilters']>[number];
const VALID_AGING_FILTERS = new Set<AgingFilter>(['due-soon', 'overdue-90', 'viewed-unpaid']);

// Shape only, not RFC version bits — Zod 4's uuid() rejects the seeded ids.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAgingFilters(raw: unknown): AgingFilter[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  return arr.filter((v): v is AgingFilter => VALID_AGING_FILTERS.has(v as AgingFilter));
}

export type CustomerInvoiceListParseResult =
  | { ok: true; filters: CustomerInvoiceListFilters }
  | { ok: false; error: string };

export function parseCustomerInvoiceListParams(query: Record<string, unknown>): CustomerInvoiceListParseResult {
  const { status, limit: limitParam = '25', page: pageParam = '1', q, client_id } = query;

  // A repeated `client_id` arrives as an array; dropping it would widen the list.
  if (client_id !== undefined && typeof client_id !== 'string') return { ok: false, error: 'client_id must be a single UUID' };
  const clientId = client_id && client_id.trim() ? client_id.trim() : null;
  if (clientId && !UUID_SHAPE.test(clientId)) return { ok: false, error: 'client_id must be a UUID' };

  const range = parseInvoiceDateRange(query);
  if (!range.ok) return range;

  // Cap at 100 — aligns with BL-11 / BL-24 limit policy.
  const limitNum = Number(limitParam);
  const pageNum = Number(pageParam);
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(Math.floor(limitNum), 100) : 25;
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;

  const statusValues: string[] | null = Array.isArray(status)
    ? status.map(String)
    : typeof status === 'string' && status && status !== 'all' ? [status] : null;

  const rawSearch = typeof q === 'string' ? q.trim() : '';

  return {
    ok: true,
    filters: {
      status: statusValues,
      clientId,
      search: rawSearch || null,
      agingFilters: parseAgingFilters(query.aging),
      dateFrom: range.fromDate ?? null,
      dateTo: range.toDate ?? null,
      limit,
      page,
    },
  };
}
