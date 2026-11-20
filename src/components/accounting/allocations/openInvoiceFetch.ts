/**
 * Loads EVERY open invoice for the allocation pages (#1685). The list APIs cap a page (supplier 200 by `limit`/`offset`,
 * customer 100 by `limit`/`page`) and the supplier API takes one status at a time, so a single request silently drops
 * rows. Here each status is read page by page until `total` is reached; if a safety cap stops it first, `truncated` says
 * so and the page shows "Showing N of M" instead of hiding the rest.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { AP_OPEN_STATUSES, AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';

type Raw = Record<string, unknown>;
export interface PageOut { rows: Raw[]; total: number }
export interface AllPages { rows: Raw[]; total: number; truncated: boolean }

export const SUPPLIER_PAGE_SIZE = 200;
export const CUSTOMER_PAGE_SIZE = 100;
export const MAX_PAGES = 25;

export async function fetchAllPages(getPage: (index: number) => Promise<PageOut>, maxPages = MAX_PAGES): Promise<AllPages> {
  const rows: Raw[] = [];
  let total = 0;
  for (let i = 0; i < maxPages; i++) {
    const out = await getPage(i);
    total = out.total;
    rows.push(...out.rows);
    if (out.rows.length === 0 || rows.length >= out.total) return { rows, total, truncated: false };
  }
  return { rows, total, truncated: true };
}

async function readPage(url: string, message: string): Promise<PageOut> {
  const res = await apiFetch(url, { credentials: 'include' });
  await assertOk(res, message);
  const json = await res.json();
  const d = json.data;
  const rows: Raw[] = Array.isArray(d) ? d : d?.invoices || d?.items || [];
  return { rows, total: Number(d?.total ?? rows.length) };
}

/** Every approved and partially paid bill of one supplier. */
export async function fetchSupplierOpenBills(supplierId: string): Promise<AllPages> {
  const all: AllPages = { rows: [], total: 0, truncated: false };
  for (const status of AP_OPEN_STATUSES) {
    const part = await fetchAllPages(i => readPage(
      `/api/accounting/supplier-invoices?supplier_id=${supplierId}&status=${status}&limit=${SUPPLIER_PAGE_SIZE}&offset=${i * SUPPLIER_PAGE_SIZE}`,
      'Could not load the supplier invoices - try again'));
    all.rows.push(...part.rows); all.total += part.total; all.truncated = all.truncated || part.truncated;
  }
  const seen = new Set<string>(); // a bill is in one status, but never list one twice
  all.rows = all.rows.filter(r => { const id = String(r.id); if (seen.has(id)) return false; seen.add(id); return true; });
  return all;
}

/** Every open invoice of one customer (all open statuses in one query, paged). */
export async function fetchCustomerOpenInvoices(clientId: string): Promise<AllPages> {
  const statuses = AR_OPEN_STATUSES.map(s => `status=${s}`).join('&');
  return fetchAllPages(i => readPage(
    `/api/accounting/customer-invoices-list?client_id=${clientId}&${statuses}&limit=${CUSTOMER_PAGE_SIZE}&page=${i + 1}`,
    'Could not load invoices for this receipt - try again'));
}
