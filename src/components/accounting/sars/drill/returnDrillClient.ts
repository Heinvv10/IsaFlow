/** Client for GET /api/accounting/sars/return-drill (L3s). Throws on a non-2xx, with the server's message. */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import type { Vat201DrillResult } from '@/modules/accounting/services/reports/vat201FieldDrill';

/** The server's page cap: one request per page keeps a long drill well inside the route's rate limit. */
export const DRILL_PAGE_SIZE = 200;
/** The route refuses a window longer than this. */
export const MAX_DRILL_WINDOW_DAYS = 400;

/** The route wants YYYY-MM-DD; a period bound may arrive as a full timestamp. */
const day = (s: string): string => s.slice(0, 10);

export function windowTooLong(from: string, to: string): boolean {
  return (Date.parse(day(to)) - Date.parse(day(from))) / 86_400_000 > MAX_DRILL_WINDOW_DAYS;
}

export async function fetchVat201Drill(field: string, from: string, to: string, page: number, signal?: AbortSignal): Promise<Vat201DrillResult> {
  const qs = new URLSearchParams({
    return: 'vat201', field, from: day(from), to: day(to), page: String(page), pageSize: String(DRILL_PAGE_SIZE),
  });
  const res = await apiFetch(`/api/accounting/sars/return-drill?${qs}`, { credentials: 'include', signal });
  await assertOk(res, 'The lines behind this field could not be loaded.');
  const json = await res.json() as { data: Vat201DrillResult };
  return json.data;
}
