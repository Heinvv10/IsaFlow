import type { Pool } from 'pg';

/**
 * Fixture only: writes an approval row the 688 transition guard refuses, to stand in for a legacy or corrupted
 * row (a moved clock, an uppercase entity id, an erased effect link). session_replication_role=replica skips
 * user triggers for this one transaction and needs a superuser; no application role can do this.
 */
export async function rewriteApprovalUnguarded(pool: Pool, text: string, params: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query(text, params);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
