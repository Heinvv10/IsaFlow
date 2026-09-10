/**
 * K-071 round-9 — the archive path's delete order, on real SQL.
 *
 * The round-9 enumeration (every `UPDATE`/`DELETE`/`FOR UPDATE` in `src/`,
 * `pages/` and `scripts/`, tagged by relation family) surfaced
 * `archiveExecutionService` step 6 as a fourth path missing from the canonical
 * table in `src/modules/accounting/services/bank/.claude.md`. It deleted
 * `gl_journal_lines` → `gl_journal_entries` → `bank_transactions` →
 * `customer_invoices` → `supplier_invoices`: the exact inverse of the canonical
 * bank → payment → invoice → GL order, and — because
 * `bank_transactions.matched_journal_line_id` FKs `gl_journal_lines` with
 * NO ACTION — an FK violation as well, on precisely the pair the step exists to
 * archive.
 *
 * So this is not a lock-order test that has to interleave two clients to say
 * anything. The defect is deterministic: seed ONE reconciled bank line pointing
 * at ONE pre-cutoff posted journal line and run the real `executeArchive`.
 *
 * MEASURED both directions. In canonical order the archive completes and all
 * three rows move. With the old order restored, Postgres raises
 * `23503 bank_transactions_matched_journal_line_id_fkey` and the whole archive
 * rolls back to its savepoint — the run marked failed, nothing archived.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CUTOFF = '2005-01-01';
/** Before CUTOFF, so every seeded row is inside the archive window. */
const OLD_DAY = '2001-01-01';

let company: string;
let user: string;
let bankAccount: string;
let journal: string;
let journalLine: string;
let bankTx: string;

beforeAll(async () => {
  company = crypto.randomUUID();
  user = crypto.randomUUID();
  bankAccount = crypto.randomUUID();
  journal = crypto.randomUUID();
  journalLine = crypto.randomUUID();
  bankTx = crypto.randomUUID();

  // Its OWN company: `executeArchive` deletes company-wide by cutoff date, so
  // sharing the K-074 fixture would archive a peer branch's rows out from under
  // it on this shared fixture database.
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K071 archive company']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,
       account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'K71ARCB','K071 Archive Bank','asset','bank','debit',true,true)`,
    [bankAccount, company],
  );
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,
       status,created_by,source)
     VALUES($1,$2,'K071-ARCH-1',$3,'archive order probe','posted',$4,'manual')`,
    [journal, company, OLD_DAY, user],
  );
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,100,0)`,
    [journalLine, company, journal, bankAccount],
  );
  // The load-bearing row: a reconciled bank line REFERENCING the journal line.
  // Without this FK edge the old order archives cleanly and the bug is invisible
  // — a fixture that only produces the passing shape makes the assertion
  // decorative.
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,
       amount,description,status,matched_journal_line_id)
     VALUES($1,$2,$3,$4,100,'archive order probe','reconciled',$5)`,
    [bankTx, company, bankAccount, OLD_DAY, journalLine],
  );
});

afterAll(async () => {
  try {
    // archive_gl_journal_lines carries no company_id — it is scoped through
    // its entry, the same way gl_journal_lines' own tenancy reads.
    await pool.query('DELETE FROM archive_gl_journal_lines WHERE journal_entry_id=$1', [journal]);
    await pool.query('DELETE FROM archive_gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM archive_bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM archive_runs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

it('archives a bank line that references a pre-cutoff journal line', async () => {
  const { als } = await import('@/lib/als');
  const { executeArchive } = await import(
    '@/modules/accounting/services/core/archiveExecutionService'
  );

  const client = await pool.connect();
  let result: Awaited<ReturnType<typeof executeArchive>>;
  try {
    await client.query('BEGIN');
    result = await als.run({ client, userId: user, companyId: company, claims: {} }, () =>
      executeArchive(company, CUTOFF, user),
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Naming the SQLSTATE here is what makes the mutation readable: restoring
    // the old order fails this test with 23503 rather than with a bare message.
    throw new Error(
      `executeArchive threw ${(err as { code?: string }).code ?? ''} ${(err as Error).message}`,
    );
  } finally {
    client.release();
  }

  expect(result.transactionsArchived).toBe(1);
  expect(result.linesArchived).toBe(1);
  expect(result.entriesArchived).toBe(1);

  // The originals are gone and the run completed — not merely "no error".
  const live = await pool.query(
    'SELECT (SELECT count(*) FROM bank_transactions WHERE company_id=$1) AS bt,'
    + ' (SELECT count(*) FROM gl_journal_lines WHERE company_id=$1) AS jl,'
    + ' (SELECT count(*) FROM gl_journal_entries WHERE company_id=$1) AS je',
    [company],
  );
  expect(Number(live.rows[0].bt)).toBe(0);
  expect(Number(live.rows[0].jl)).toBe(0);
  expect(Number(live.rows[0].je)).toBe(0);

  const runs = await pool.query(
    'SELECT status FROM archive_runs WHERE company_id=$1', [company],
  );
  expect(runs.rows.map((r) => r.status)).toEqual(['completed']);
}, 40000);
