/**
 * The one lock every writer of a company's system-account flags takes first:
 * the Default Accounts save and the COA import's role map. Without it two saves
 * on a company whose chart carries no role yet both committed 200s (a
 * FOR UPDATE on the role rows locks nothing when there are none), and a COA
 * import could re-flag roles between a save's read and its write.
 *
 * Transaction-scoped: released at COMMIT/ROLLBACK, so `q` must run on the
 * writer's own transaction — through the pool it would be released at once.
 */
import { sql } from '@/lib/neon';
import type { SqlExec } from './journalVatLockGuard';

export async function lockSystemRoleWrites(companyId: string, q: SqlExec = sql): Promise<void> {
  await q`SELECT pg_advisory_xact_lock(hashtextextended(${`default-accounts:${companyId}`}::TEXT, 0))`;
}
