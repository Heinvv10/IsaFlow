/**
 * One lock per company for every write to the CC1 / CC2 / BU masters.
 *
 * The master edits are planned from reads: the parent chain, the descendants,
 * the carriers of a CC2, the codes and aliases in use. Two concurrent edits
 * each plan against the master as it was before the other, so two re-parents
 * can together make a loop, or move a carried project to another FNO through
 * its programme, though each alone is refused. Every create, edit, deactivate
 * and delete of a cost centre or business unit takes this lock before its
 * first read, so the plans run one after another.
 *
 * A transaction advisory lock, not `FOR UPDATE` on cost_centres: a row lock
 * there would block the FK key-share checks every journal insert makes.
 * Outside a request transaction the lock is released when its own statement
 * ends and serialises nothing, so that case is refused.
 */
import { sql } from '@/lib/neon';
import { requireRequestTransaction } from './requestTransaction';

export async function lockDimensionMasters(companyId: string): Promise<void> {
  requireRequestTransaction('lockDimensionMasters');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dimension-master:${companyId}`}::TEXT, 0))`;
}
