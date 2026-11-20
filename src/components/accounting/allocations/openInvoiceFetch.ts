/**
 * Loads EVERY open invoice for the allocation pages (#1685). The list APIs cap a page (supplier 200 by `limit`/`offset`,
 * customer 100 by `limit`/`page`) and the supplier API takes one status at a time, so a single request silently drops
 * rows. Here each status is read page by page until `total` is reached; if a safety cap stops it first, `truncated` says
 * so and the page shows "Showing N of M" instead of hiding the rest.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { AP_OPEN_STATUSES, AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';

type Raw = Record<string, unknown>;
/** `total: null` = the API did not say; `pageSize` (the `limit` asked for) then tells a full page from the last one. */
export interface PageOut { rows: Raw[]; total: number | null; pageSize?: number }
export interface AllPages { rows: Raw[]; total: number; truncated: boolean }

export const SUPPLIER_PAGE_SIZE = 200;
export const CUSTOMER_PAGE_SIZE = 100;
export const PAYMENT_PAGE_SIZE = 200;
export const MAX_PAGES = 25;

export async function fetchAllPages(getPage: (index: number) => Promise<PageOut>, maxPages = MAX_PAGES): Promise<AllPages> {
  const rows: Raw[] = [];
  const seen = new Set<string>(); // a row that moved across a page boundary between two requests must not be listed twice
  let known: number | null = null;
  for (let i = 0; i < maxPages; i++) {
    const out = await getPage(i);
    known = out.total;
    for (const r of out.rows) {
      const id = String(r.id);
      if (!seen.has(id)) { seen.add(id); rows.push(r); }
    }
    const total = known ?? seen.size;
    if (known === null) {
      // unknown total: a short or empty page is the last one; a full page may have more behind it
      if (out.rows.length === 0 || (out.pageSize !== undefined && out.rows.length < out.pageSize)) return { rows, total, truncated: false };
    } else {
      if (seen.size >= known) return { rows, total, truncated: false };
      if (out.rows.length === 0) return { rows, total, truncated: true }; // the list ended short of its own total: say so, do not pass it off as whole
    }
  }
  return { rows, total: known ?? seen.size, truncated: true };
}

async function readPage(url: string, message: string, keys: readonly string[], pageSize: number): Promise<PageOut> {
  const res = await apiFetch(url, { credentials: 'include' });
  await assertOk(res, message);
  const json = await res.json();
  const d = json.data;
  const rows: Raw[] = Array.isArray(d) ? d : keys.map(k => d?.[k]).find(Array.isArray) ?? [];
  const raw = Array.isArray(d) ? undefined : d?.total;
  const total = raw === undefined || raw === null || !Number.isFinite(Number(raw)) ? null : Number(raw);
  return { rows, total, pageSize };
}

const INVOICE_KEYS = ['invoices', 'items'] as const;

/** Every payment / receipt (the list API pages at 200 and ignores `unallocated=true`, so the page filters). */
export async function fetchAllPayments(kind: 'supplier' | 'customer', message: string): Promise<AllPages> {
  return fetchAllPages(i => readPage(
    `/api/accounting/${kind}-payments?unallocated=true&limit=${PAYMENT_PAGE_SIZE}&offset=${i * PAYMENT_PAGE_SIZE}`, message, ['payments', 'items'], PAYMENT_PAGE_SIZE));
}

/** Every approved and partially paid bill of one supplier. */
export async function fetchSupplierOpenBills(supplierId: string): Promise<AllPages> {
  const all: AllPages = { rows: [], total: 0, truncated: false };
  for (const status of AP_OPEN_STATUSES) {
    const part = await fetchAllPages(i => readPage(
      `/api/accounting/supplier-invoices?supplier_id=${supplierId}&status=${status}&limit=${SUPPLIER_PAGE_SIZE}&offset=${i * SUPPLIER_PAGE_SIZE}`,
      'Could not load the supplier invoices - try again', INVOICE_KEYS, SUPPLIER_PAGE_SIZE));
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
    'Could not load invoices for this receipt - try again', INVOICE_KEYS, CUSTOMER_PAGE_SIZE));
}
