/**
 * A company_users row whose user has NO users row: an orphan as one written before
 * migration 996 added company_users_user_id_fkey (NOT VALID, so such rows survive it;
 * production holds one). The FK refuses a new one at COMMIT, so the row is written with
 * the RI triggers off (session_replication_role = replica, superuser only: the suites'
 * `postgres`), for this one INSERT. That also skips the row's other triggers (role guard,
 * entity_change_capture), which judge nothing for a superuser's seed anyway.
 */
import type { Pool } from 'pg';

export async function insertPreFkOrphanMembership(
  pool: Pool, companyId: string, userId: string, role: string,
): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [companyId, userId, role]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
