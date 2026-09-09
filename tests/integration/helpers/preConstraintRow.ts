/**
 * Write a row that migration 664 makes unrepresentable.
 *
 * `gl_journal_lines_account_company_fk` refuses a line whose `company_id`
 * disagrees with its GL account's, and the fixtures that use this helper create
 * exactly that shape ON PURPOSE — to prove that a guard ignores another
 * tenant's line, or that a detector finds one. The rows are real: 664 is
 * NOT VALID, so every such row written before it survives in production, which
 * is what those guards exist for.
 *
 * `session_replication_role = 'replica'` suppresses the FK trigger for ONE
 * transaction (superuser-only; the disposable fixture DB connects as one), and
 * `SET LOCAL` reverts it at COMMIT — so the constraint governs every other
 * writer, including the code under test.
 */
import type { Pool } from 'pg';

export async function insertPreConstraintRow(
  pool: Pool,
  text: string,
  values: unknown[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(text, values);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
