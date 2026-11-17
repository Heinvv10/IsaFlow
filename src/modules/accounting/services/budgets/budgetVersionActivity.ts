/**
 * Who last changed each budget version and when: the newest `audit_log` row of entity 'budget' for it
 * (every budget write leaves one: amount saves, seeds, notes, copies, primary changes; status moves are
 * audited by the database trigger the same way). The audit log is the version history the app shows
 * (Audit log, entity Budget), so this answers from the same rows. One read for all the versions asked.
 */
import { sql, type DbRow } from '@/lib/neon';

export interface VersionLastEdit { at: string; by: string | null; action: string }

export async function lastEditsOf(companyId: string, versionIds: readonly string[]): Promise<Map<string, VersionLastEdit>> {
  const out = new Map<string, VersionLastEdit>();
  if (versionIds.length === 0) return out;
  const rows = (await sql`
    SELECT DISTINCT ON (entity_id) entity_id::text AS version_id, user_id, action,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
      FROM audit_log
     WHERE company_id = ${companyId}::UUID AND entity_type = 'budget' AND entity_id = ANY(${[...versionIds]}::UUID[])
     ORDER BY entity_id, created_at DESC, id DESC
  `) as DbRow[];
  for (const r of rows) {
    out.set(String(r.version_id), { at: String(r.at), by: r.user_id === null || r.user_id === undefined ? null : String(r.user_id), action: String(r.action) });
  }
  return out;
}

/**
 * How many driver writes the version has had at or after `since` (a version token: the transaction time of a
 * write, so that write's own transaction counts too). Every driver line, override reset, planned hire and
 * headcount refresh write runs through drivers/driverWriteScope.runDriverWrite, whose audit row carries
 * `driverAction` (created_at = its transaction's now()). The restore of an amount write refuses on any
 * (budgetSnapshotRestore): it puts cells back, never drivers.
 */
export async function driverChangesSince(companyId: string, versionId: string, since: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM audit_log
     WHERE company_id = ${companyId}::UUID AND entity_type = 'budget' AND entity_id = ${versionId}::UUID
       AND (changes -> 'metadata' ->> 'driverAction') IS NOT NULL AND created_at >= ${since}::TIMESTAMPTZ
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}
