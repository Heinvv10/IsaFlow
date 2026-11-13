/**
 * Token expiry as an ISO string, for token_info (src/lib/mcp/tools/tokenInfo.ts).
 * pg returns timestamps as Date; a string or a missing value must never fail authentication,
 * so anything unreadable is null.
 */
export function isoOrNull(v: unknown): string | null {
  if (!(v instanceof Date) && typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
