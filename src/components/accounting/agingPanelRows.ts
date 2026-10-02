/**
 * Rows for an AR/AP Aging drill-down panel.
 *
 * The rows come from the aging's own per-entity detail endpoint
 * (`/api/accounting/{ar,ap}-aging?{client,supplier}_id=&as_at_date=`), so the
 * panel lists exactly the invoices and as-at balances the bucket row above it
 * sums — including one paid since the as-at date.
 */

import { ApiEnvelopeError, apiFetch, assertOk } from '@/lib/apiFetch';
import type { AgingDetailInvoice } from '@/modules/accounting/utils/aging';

export type AgingSide = 'ar' | 'ap';

export type AgingPanelRow = AgingDetailInvoice;

export async function loadAgingPanelRows(side: AgingSide, entityId: string, asAtDate: string): Promise<AgingPanelRow[]> {
  const params = new URLSearchParams({ [side === 'ar' ? 'client_id' : 'supplier_id']: entityId, as_at_date: asAtDate });
  const res = await apiFetch(`/api/accounting/${side}-aging?${params}`);
  await assertOk(res, 'Could not load the invoices - try again');
  const json = await res.json() as { data?: { invoices?: unknown } };
  if (!json.data || typeof json.data !== 'object') throw new ApiEnvelopeError('Could not load the invoices - try again');
  return Array.isArray(json.data.invoices) ? json.data.invoices as AgingPanelRow[] : [];
}

/** Whole days between the due date and the as-at date; 0 when not yet due. */
export function daysOverdueAsAt(dueDate: string, asAtDate: string): number {
  const due = new Date(dueDate);
  const asAt = new Date(`${asAtDate}T00:00:00`);
  due.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((asAt.getTime() - due.getTime()) / 86_400_000));
}
