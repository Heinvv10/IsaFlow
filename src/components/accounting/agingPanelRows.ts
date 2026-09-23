/**
 * Rows for an AR/AP Aging drill-down panel.
 *
 * The rows come from the aging's own per-entity detail endpoint
 * (`/api/accounting/{ar,ap}-aging?{client,supplier}_id=&as_at_date=`), so the
 * panel lists exactly the invoices and as-at balances the bucket row above it
 * sums — including one paid since the as-at date. That endpoint carries no
 * invoice number, so numbers are looked up by id from the entity's invoice
 * list; an id the list cannot resolve still links, it just has no number.
 */

import { apiFetch } from '@/lib/apiFetch';
import type { AgingInvoice } from '@/modules/accounting/types/ap.types';

export type AgingSide = 'ar' | 'ap';

export interface AgingPanelRow extends AgingInvoice {
  invoiceNumber: string | null;
}

interface ListSpec {
  pageSize: number;
  url: (entityId: string, pageIndex: number) => string;
  number: (row: Record<string, unknown>) => unknown;
}

const LIST: Record<AgingSide, ListSpec> = {
  ar: {
    pageSize: 100,
    url: (id, i) => `/api/accounting/customer-invoices-list?${new URLSearchParams({ client_id: id, limit: '100', page: String(i + 1) })}`,
    number: row => row.invoice_number,
  },
  ap: {
    pageSize: 200,
    url: (id, i) => `/api/accounting/supplier-invoices?${new URLSearchParams({ supplier_id: id, limit: '200', offset: String(i * 200) })}`,
    number: row => row.invoiceNumber,
  },
};

async function getData(url: string): Promise<Record<string, unknown>> {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { data?: unknown };
  if (!json.data || typeof json.data !== 'object') throw new Error('Unexpected response');
  return json.data as Record<string, unknown>;
}

async function resolveNumbers(side: AgingSide, entityId: string, wanted: Set<string>): Promise<Map<string, string>> {
  const spec = LIST[side];
  const found = new Map<string, string>();
  for (let page = 0; found.size < wanted.size; page++) {
    const data = await getData(spec.url(entityId, page));
    const rows = Array.isArray(data.invoices) ? data.invoices as Record<string, unknown>[] : [];
    for (const row of rows) {
      const id = String(row.id);
      const num = spec.number(row);
      if (wanted.has(id) && typeof num === 'string') found.set(id, num);
    }
    const total = typeof data.total === 'number' ? data.total : 0;
    if (rows.length < spec.pageSize || (page + 1) * spec.pageSize >= total) break;
  }
  return found;
}

export async function loadAgingPanelRows(side: AgingSide, entityId: string, asAtDate: string): Promise<AgingPanelRow[]> {
  const params = new URLSearchParams({ [side === 'ar' ? 'client_id' : 'supplier_id']: entityId, as_at_date: asAtDate });
  const detail = await getData(`/api/accounting/${side}-aging?${params}`);
  const invoices = Array.isArray(detail.invoices) ? detail.invoices as AgingInvoice[] : [];
  if (invoices.length === 0) return [];
  const numbers = await resolveNumbers(side, entityId, new Set(invoices.map(inv => inv.id)));
  return invoices.map(inv => ({ ...inv, invoiceNumber: numbers.get(inv.id) ?? null }));
}

/** Whole days between the due date and the as-at date; 0 when not yet due. */
export function daysOverdueAsAt(dueDate: string, asAtDate: string): number {
  const due = new Date(dueDate);
  const asAt = new Date(`${asAtDate}T00:00:00`);
  due.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((asAt.getTime() - due.getTime()) / 86_400_000));
}
