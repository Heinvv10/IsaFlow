/**
 * "Received by" for a goods received note. A note whose received_by is its creator's id (the server's default when no
 * receiver is typed) is shown as that user's name, resolved once per distinct user through approval_company_member_name
 * (mig 714: the caller's own company members only; name, else email). Typed text is kept as typed. An id that no longer
 * resolves (the user left the company) shows "Unknown user", never the raw id.
 */
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

export async function attachReceiverNames<T extends Row>(companyId: string, rows: T[]): Promise<Array<T & { received_by_name: string | null }>> {
  const byCreator = (r: Row) => r.received_by != null && r.received_by === r.created_by;
  const ids = [...new Set(rows.filter(byCreator).map((r) => String(r.created_by)))];
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const found = (await sql`
      SELECT u.id, public.approval_company_member_name(${companyId}::UUID, u.id) AS name
        FROM unnest(${ids}::TEXT[]) AS u(id)
    `) as Row[];
    for (const f of found) names.set(String(f.id), f.name == null ? null : String(f.name));
  }
  return rows.map((r) => ({
    ...r,
    received_by_name: byCreator(r) ? (names.get(String(r.created_by)) ?? 'Unknown user') : r.received_by == null ? null : String(r.received_by),
  }));
}
