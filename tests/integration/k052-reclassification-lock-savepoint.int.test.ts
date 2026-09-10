/**
 * K-052 (round 5) — a caught lock timeout must leave the transaction USABLE.
 *
 * `lockGlAccountsForUpdate` issues `FOR UPDATE` with a 5s `lock_timeout`. The
 * timeout raises SQLSTATE 55P03, which ABORTS the (sub)transaction.
 * `planFromArgs` catches `GL_ACCOUNT_LOCK_TIMEOUT` and RETURNS a toolError, so
 * `registry.call` — which runs every write tool inside `withSavepoint` — takes
 * the NORMAL-return path and issues `RELEASE SAVEPOINT` on an aborted
 * subtransaction. That raises 25P02, the throw escapes as GENERIC_FAILURE, and
 * the wording the catch exists to preserve is discarded anyway.
 *
 * Catching a SQL error does not un-poison a transaction; only a savepoint
 * rollback does. Both locks now run in their own `withSavepoint`, and this file
 * is the end-to-end proof: through the REAL write tool, inside the SAME
 * savepoint shape the registry uses, against a real Postgres, with a second
 * connection genuinely holding the row.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { getPoolForTests, sql, withSavepoint } from '../../src/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { postReclassificationBatchTool } from '../../src/lib/mcp/tools/writeReclassification';
import { savepointNameFor } from '../../src/lib/mcp/registry';
import type { McpToolContext } from '../../src/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const source = crypto.randomUUID(), target = crypto.randomUUID();
const equity = crypto.randomUUID(), lineTarget = crypto.randomUUID();

const CTX = {
  companyId: company, userId: user,
  scopes: ['read:reports', 'write:journals', 'write:post'],
  tokenJti: 'jti-1', oauthAppId: null,
} as unknown as McpToolContext;

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K052 savepoint fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  // The target is a CHILDLESS level-2 asset: `isSubjectToLeafRule` is true, so
  // the write path takes the account lock, and `isReportVisibleLeaf` admits it,
  // so nothing refuses before the lock is reached.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K052S-1900','K052S Bonds (level 2 leaf)','asset','debit',2,true),
            ($3,$2,'K052S-1950','K052S Bond deposits','asset','debit',3,true),
            ($4,$2,'K052S-3000','K052S Retained earnings','equity','credit',3,true),
            ($5,$2,'K052S-1960','K052S Bond deposits (other)','asset','debit',3,true)`,
    [target, company, source, equity, lineTarget]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K052S Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`, [company]);
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,posted_at)
     VALUES($1,'K052S-JE-1','2026-03-15'::date,'K052S seed','manual','posted',$2,NOW()) RETURNING id`,
    [company, user]);
  for (const [account, debit, credit] of [[source, 400, 0], [equity, 0, 400]] as const) {
    await pool.query(
      'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
      [rows[0].id, account, debit, credit, company]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('hands the agent the retry wording, not 25P02, when the target is held', async () => {
  // A second connection holds the target row for the whole call, so the 5s
  // `lock_timeout` elapses for real. Nothing is simulated.
  const holder = await pool.connect();
  const runner = await getPoolForTests().connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM gl_accounts WHERE id=$1 FOR UPDATE', [target]);

    await runner.query('BEGIN');
    const { out, afterwards } = await als.run(
      { client: runner, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      async () => {
        // EXACTLY registry.call's shape for a write tool.
        const result = await withSavepoint(
          savepointNameFor('post_reclassification_batch'),
          () => postReclassificationBatchTool.handler(
            {
              source_account_id: source, target_account_id: target,
              idempotency_key: 'k052s-lock-1',
            },
            CTX,
          ),
        );
        // The transaction has to survive the refusal: the registry writes its
        // audit row on the surviving request tx after the savepoint returns.
        const probe = (await sql`SELECT 1 AS ok`) as { ok: number }[];
        return { out: result, afterwards: probe.length };
      },
    );
    await runner.query('COMMIT');

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain(target);
    expect(out.content[0]!.text).toContain('retry');
    // Not the generic wording the aborted transaction produced.
    expect(out.content[0]!.text).not.toContain('aborted');
    expect(afterwards).toBe(1);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await runner.query('ROLLBACK').catch(() => undefined);
    (runner as PoolClient).release();
  }
}, 30_000);

it('nothing was written, so the idempotency key stays free for the retry', async () => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM reclassification_batches WHERE company_id=$1', [company]);
  expect(rows[0].n).toBe(0);
  const lines = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE company_id=$1 AND gl_account_id=$2',
    [company, target]);
  expect(lines.rows[0].n).toBe(0);
});

it('does the same for the LINE lock: the savepoint around it is what keeps the tx usable', async () => {
  // The other call site, three files away. `lockReclassLinesForUpdate` in
  // `plan.ts` runs in its own `withSavepoint` for exactly the reason
  // `lockGlAccountsForUpdate` does, and nothing else in the suite goes red if
  // that wrap is removed: the test above is refused at the ACCOUNT lock and
  // never reaches the candidate lines, and the unit tests either mock
  // `planReclassification` out entirely or call the lock helper directly, with
  // no transaction to poison.
  //
  // `lineTarget` is a CHILDLESS LEVEL-3 asset, so `isSubjectToLeafRule` is
  // false and the account lock is skipped — the line lock is the first lock the
  // request takes, and the only one contended here.
  const holder = await pool.connect();
  const runner = await getPoolForTests().connect();
  try {
    await holder.query('BEGIN');
    const held = await holder.query(
      'SELECT id FROM gl_journal_lines WHERE company_id=$1 AND gl_account_id=$2 FOR UPDATE',
      [company, source]);
    expect(held.rowCount).toBe(1);

    await runner.query('BEGIN');
    const { out, afterwards } = await als.run(
      { client: runner, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      async () => {
        const result = await withSavepoint(
          savepointNameFor('post_reclassification_batch'),
          () => postReclassificationBatchTool.handler(
            {
              source_account_id: source, target_account_id: lineTarget,
              idempotency_key: 'k052s-lock-2',
            },
            CTX,
          ),
        );
        const probe = (await sql`SELECT 1 AS ok`) as { ok: number }[];
        return { out: result, afterwards: probe.length };
      },
    );
    await runner.query('COMMIT');

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('retry');
    // 25P02's wording, which is what a missing savepoint produces here.
    expect(out.content[0]!.text).not.toContain('aborted');
    expect(afterwards).toBe(1);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await runner.query('ROLLBACK').catch(() => undefined);
    (runner as PoolClient).release();
  }
}, 30_000);

it('the line-lock refusal posted nothing either', async () => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM reclassification_batches WHERE company_id=$1', [company]);
  expect(rows[0].n).toBe(0);
  const moved = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE company_id=$1 AND gl_account_id=$2',
    [company, lineTarget]);
  expect(moved.rows[0].n).toBe(0);
});
