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
 * transaction, and `SET LOCAL` reverts it at COMMIT — so the constraint governs
 * every other writer, including the code under test.
 *
 * TWO THINGS THIS IS NOT:
 *
 * 1. It is not "the same INSERT, minus one constraint". `replica` suppresses
 *    EVERY user trigger on the table, and `gl_journal_lines` carries
 *    `trg_gl_jl_balance_update` (AFTER INSERT/UPDATE/DELETE →
 *    `update_account_balances()`). A row written through here therefore does
 *    NOT maintain `gl_account_balances`. Assert on `gl_journal_lines`, or
 *    re-run the balance maintenance yourself; never assert a balance that this
 *    row was supposed to have moved.
 * 2. It is not available to every role. `session_replication_role` is
 *    SUSET-context: superuser, or a role explicitly `GRANT SET`-ed the
 *    parameter. The disposable fixture DB connects as `postgres`, so it works
 *    there; on a database whose integration role is not a superuser the four
 *    fixtures that call this fail loudly, with the message below rather than a
 *    bare `permission denied`.
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
    try {
      await client.query("SET LOCAL session_replication_role = 'replica'");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42501') {
        throw new Error(
          'insertPreConstraintRow needs a superuser (or a role GRANT SET on ' +
            'session_replication_role): it writes a row that migration 664 ' +
            'refuses, on purpose. Point the integration suite at the disposable ' +
            'fixture database, which connects as postgres.',
          { cause: err },
        );
      }
      throw err;
    }
    await client.query(text, values);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
