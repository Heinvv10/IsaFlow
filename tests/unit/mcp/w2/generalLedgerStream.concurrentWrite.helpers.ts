/**
 * A peer session's write, for generalLedgerStream.integration.test.ts's R-165
 * regression test. Runs on its OWN `pg.Pool` connection — autocommitting
 * immediately, exactly like another agent's run committing to isaflow_dev
 * while ours is mid-flight — never on the ALS-bound client the transaction
 * under test uses.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

export const CONCURRENT_WRITE_MARKER = 'R-165 regression: concurrent write mid-read';

/**
 * Refuses to write to isaflow_dev or prod, even if a caller forgets the
 * suite's own `canWriteHere` skip guard — `env -u DATABASE_URL` does not
 * actually unset it in this repo's vitest config (vite's loadEnv re-reads
 * .env.local), so a naive `DATABASE_URL` check is not enough on its own.
 */
function assertDisposableTarget(): void {
  let dbName = '';
  try {
    dbName = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  } catch {
    // falls through to the empty-name refusal below
  }
  if (dbName === '' || dbName === 'isaflow_dev' || dbName === 'isaflow') {
    throw new Error(
      `refusing to write a concurrent test entry to database "${dbName || '(unresolved)'}" — ` +
        'this helper only ever writes to a disposable fixture',
    );
  }
}

/**
 * Commits one balanced posted entry (a debit and its matching credit, 2
 * lines) onto the company's first two accounts, dated at `entryDate` so it
 * lands before every seeded line in the window — shifting every later
 * `runningBalance` on the debited/credited accounts. Returns the posted line
 * count read back on this SAME connection right after the commit, so a
 * caller can prove the write really landed without relying on the
 * transaction under test — which, once fixed, must NOT see it.
 */
export async function commitConcurrentPostedLine(
  companyId: string,
  amount: number,
  entryDate: string,
): Promise<number> {
  assertDisposableTarget();
  const writer = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const accounts = (await writer.query(
      'SELECT id FROM gl_accounts WHERE company_id = $1 ORDER BY account_code LIMIT 2',
      [companyId],
    )).rows as Array<{ id: string }>;
    if (accounts.length < 2) throw new Error('busiest company needs at least 2 accounts to balance a line');
    const je = (await writer.query(
      `INSERT INTO gl_journal_entries (entry_date, status, company_id, created_by, source, description)
       VALUES ($1, 'posted', $2, $3, 'manual', $4)
       RETURNING id`,
      [entryDate, companyId, randomUUID(), CONCURRENT_WRITE_MARKER],
    )).rows[0].id;
    await writer.query(
      `INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, company_id, debit, credit)
       VALUES ($1, $2, $4, $3, 0), ($1, $5, $4, 0, $3)`,
      [je, accounts[0]!.id, amount, companyId, accounts[1]!.id],
    );
    const after = await writer.query(
      `SELECT COUNT(*)::int AS n FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
       WHERE jl.company_id = $1`,
      [companyId],
    );
    return (after.rows[0] as { n: number }).n;
  } finally {
    await writer.end();
  }
}

/** Undoes `commitConcurrentPostedLine`, so re-running the suite is idempotent. */
export async function deleteConcurrentPostedLine(): Promise<void> {
  const writer = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await writer.query('DELETE FROM gl_journal_entries WHERE description = $1', [CONCURRENT_WRITE_MARKER]);
  } finally {
    await writer.end();
  }
}
