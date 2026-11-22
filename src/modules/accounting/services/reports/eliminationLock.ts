/**
 * The per-group lock of everything that decides which eliminations of a group STAND (the generator's run, a manual elimination of a mirrored row):
 * a transaction-scoped advisory lock, so two writers see each other's rows even where 1019 could not build the partial unique index (legacy
 * duplicates). Outside a transaction the lock would be released at the end of its own statement and serialise nothing, so that is refused.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

export async function lockGroupEliminations(groupId: string, caller: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext('consolidation-eliminations:' || ${groupId}::TEXT))`;
  const held = (await sql`
    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
       AND objsubid = 1 AND objid = (hashtext('consolidation-eliminations:' || ${groupId}::TEXT)::bigint & 4294967295)::oid
  `) as DbRow[];
  if (held.length === 0) throw new Error(`${caller} must run inside a transaction (its per-group advisory lock is transaction-scoped)`);
}
