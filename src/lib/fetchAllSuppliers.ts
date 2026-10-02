/**
 * Every supplier for the company, paged to the end. /suppliers-list answers 25
 * rows unless told otherwise (PUR-01), so a client-filtered picker that loads the
 * bare route silently loses every supplier past the 25th. Use SupplierSelect
 * (server-side search) for new forms; this is for pickers that filter the whole
 * list in memory (bank allocation) and cannot be turned into a lookup without
 * rewriting every allocation cell.
 */

import { apiFetch, assertOk } from './apiFetch';
import { log } from './logger';

interface SupplierRow { id: number | string; name: string; code?: string }

export interface AllSuppliers {
  suppliers: SupplierRow[];
  /** True when MAX_PAGES stopped the walk before the route ran out of rows. */
  truncated: boolean;
}

const PAGE_SIZE = 200; // the route's hard cap
const MAX_PAGES = 50;
/** Most suppliers this loader will return; beyond it `truncated` is true. */
export const SUPPLIER_LIST_CAP = PAGE_SIZE * MAX_PAGES;

export const truncatedSuppliersNotice = () =>
  `Showing the first ${SUPPLIER_LIST_CAP.toLocaleString('en-ZA')} suppliers — search is limited to these.`;

export async function fetchAllSuppliers(): Promise<AllSuppliers> {
  const byId = new Map<string, SupplierRow>();
  let done = false;
  for (let page = 1; page <= MAX_PAGES && !done; page++) {
    const res = await apiFetch(`/api/accounting/suppliers-list?limit=${PAGE_SIZE}&page=${page}`, { credentials: 'include' });
    await assertOk(res, 'Could not load the suppliers - try again');
    const json = await res.json();
    const d = (json.data ?? json) as { suppliers?: SupplierRow[]; total?: number } | SupplierRow[];
    const rows = Array.isArray(d) ? d : (d.suppliers ?? []);
    for (const r of rows) byId.set(String(r.id), r); // a row moving between pages must not appear twice
    const total = Array.isArray(d) ? undefined : d.total;
    done = rows.length < PAGE_SIZE || (typeof total === 'number' && byId.size >= total);
  }
  if (!done) log.warn('Supplier list truncated at page cap', { pages: MAX_PAGES, loaded: byId.size }, 'suppliers');
  return { suppliers: [...byId.values()], truncated: !done };
}
