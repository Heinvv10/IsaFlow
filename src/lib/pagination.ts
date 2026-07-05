/**
 * Pagination caps for GET list endpoints (A–Z P3.4, June-audit remediation).
 *
 * The June audit found ~15 endpoints selecting entire large tables (worst: a
 * full invoice-history GROUP BY). Every capped endpoint parses its query
 * through these helpers so a client can never talk the API out of its cap.
 *
 * Conventions:
 * - row-list endpoints:   parsePagination(req.query)            → def 50,  max 500
 * - lookup-style lists:   parsePagination(req.query, 100, 2000) → documented-intentional
 * - CSV exports:          use EXPORT_ROW_CEILING and emit a truncation marker
 */

export interface PageParams {
  limit: number;
  offset: number;
}

/** Hard ceiling for CSV export endpoints — beyond this the export truncates
 *  with an explicit marker row rather than dumping unbounded history. */
export const EXPORT_ROW_CEILING = 10_000;

/**
 * Clamp a query-string limit value: missing/garbage/≤0 → `def`, numeric
 * values floor to an integer and cap at `max`. Repeated params (string[])
 * use the first element.
 */
export function clampLimit(value: unknown, def = 50, max = 500): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return def;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Parse `limit` + `offset` from a query object with clamped, safe values. */
export function parsePagination(
  query: Record<string, unknown>,
  def = 50,
  max = 500,
): PageParams {
  const rawOffset = Array.isArray(query.offset) ? query.offset[0] : query.offset;
  const parsedOffset = Number(String(rawOffset ?? ''));
  const offset =
    Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : Math.floor(parsedOffset);
  return { limit: clampLimit(query.limit, def, max), offset };
}
