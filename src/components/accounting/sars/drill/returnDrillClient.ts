/** Client for GET /api/accounting/sars/return-drill (L3s). Throws on a non-2xx, with the server's message. */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import type { Vat201DrillResult } from '@/modules/accounting/services/reports/vat201FieldDrill';

export const DRILL_PAGE_SIZE = 50;

/** The route wants YYYY-MM-DD; a period bound may arrive as a full timestamp. */
const day = (s: string): string => s.slice(0, 10);

export async function fetchVat201Drill(field: string, from: string, to: string, page: number, signal?: AbortSignal): Promise<Vat201DrillResult> {
  const qs = new URLSearchParams({
    return: 'vat201', field, from: day(from), to: day(to), page: String(page), pageSize: String(DRILL_PAGE_SIZE),
  });
  const res = await apiFetch(`/api/accounting/sars/return-drill?${qs}`, { credentials: 'include', signal });
  await assertOk(res, 'The lines behind this field could not be loaded.');
  const json = await res.json() as { data: Vat201DrillResult };
  return json.data;
}
