/**
 * URL <-> filter state for the customer invoice list.
 *
 * Page URL: `?status=&q=&customer=&from=&to=&aging=&page=` — bookmarkable and
 * the target of the aging dashboards' "View all invoices" links. The legacy
 * `?filter=<status>` deep link (dashboard widgets) is still read.
 *
 * Hydration is lenient: an invalid value in a hand-edited URL is dropped so the
 * page still renders. The API is the strict side — it 400s on a bad date.
 */

import { parseAgingParam, type AgingFilterId } from '@/components/invoices/ARFilters';
import { isCalendarDate } from '@/modules/accounting/services/core/invoiceDateRangeParams';

export const AR_STATUSES = ['all', 'draft', 'approved', 'sent', 'partially_paid', 'paid', 'overdue'] as const;
export type ARStatus = typeof AR_STATUSES[number];

export interface ARListFilters {
  status: ARStatus;
  search: string;
  customerId: string;
  from: string;
  to: string;
  aging: AgingFilterId[];
  page: number;
}

export const AR_DEFAULTS: ARListFilters = {
  status: 'all', search: '', customerId: '', from: '', to: '', aging: [], page: 1,
};

type Query = Record<string, string | string[] | undefined>;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(q: Query, key: string): string {
  const v = q[key];
  return typeof v === 'string' ? v : '';
}

function isStatus(v: string): v is ARStatus {
  return (AR_STATUSES as readonly string[]).includes(v);
}

export function hydrateARFilters(query: Query): ARListFilters {
  const statusRaw = str(query, 'status') || str(query, 'filter');
  const customer = str(query, 'customer');
  let from = isCalendarDate(str(query, 'from')) ? str(query, 'from') : '';
  let to = isCalendarDate(str(query, 'to')) ? str(query, 'to') : '';
  if (from && to && from > to) { from = ''; to = ''; }
  const page = Math.floor(Number(str(query, 'page')));

  return {
    status: isStatus(statusRaw) ? statusRaw : 'all',
    search: str(query, 'q'),
    customerId: UUID_SHAPE.test(customer) ? customer : '',
    from,
    to,
    aging: parseAgingParam(query.aging),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/** The page URL's query for these filters; defaults are omitted. */
export function arFiltersToQuery(f: ARListFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.status !== 'all') q.status = f.status;
  if (f.search) q.q = f.search;
  if (f.customerId) q.customer = f.customerId;
  if (f.from) q.from = f.from;
  if (f.to) q.to = f.to;
  if (f.aging.length > 0) q.aging = f.aging.join(',');
  if (f.page !== 1) q.page = String(f.page);
  return q;
}

/** The filter params the list and export APIs take, without paging. */
export function arFiltersToApiParams(f: ARListFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.status !== 'all') p.status = f.status;
  if (f.search) p.q = f.search;
  if (f.customerId) p.client_id = f.customerId;
  if (f.from) p.from_date = f.from;
  if (f.to) p.to_date = f.to;
  if (f.aging.length > 0) p.aging = f.aging.join(',');
  return p;
}
