/**
 * Every supplier for the company, paged to the end. /suppliers-list answers 25
 * rows unless told otherwise (PUR-01), so a client-filtered picker that loads the
 * bare route silently loses every supplier past the 25th. Use SupplierSelect
 * (server-side search) for new forms; this is for pickers that filter the whole
 * list in memory (bank allocation).
 */

import { apiFetch } from './apiFetch';

interface SupplierRow { id: number | string; name: string; code?: string }

const PAGE_SIZE = 200; // the route's hard cap
const MAX_PAGES = 50;

export async function fetchAllSuppliers(): Promise<SupplierRow[]> {
  const all: SupplierRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await apiFetch(`/api/accounting/suppliers-list?limit=${PAGE_SIZE}&page=${page}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const d = (json.data ?? json) as { suppliers?: SupplierRow[]; total?: number } | SupplierRow[];
    const rows = Array.isArray(d) ? d : (d.suppliers ?? []);
    all.push(...rows);
    const total = Array.isArray(d) ? undefined : d.total;
    if (rows.length < PAGE_SIZE || (typeof total === 'number' && all.length >= total)) break;
  }
  return all;
}
