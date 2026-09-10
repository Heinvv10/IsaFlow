/**
 * K-081 review round 4 — L4 and L3. The rebuild drove its per-tenant loop from
 * `SELECT DISTINCT company_id FROM loans`, so a company whose last loan was
 * deleted was never revisited: the refusal rows an earlier run wrote for it
 * stayed in `loan_reclass_backfill_refusals` reading as current when they were
 * not, and any reclass journal it still held was neither reconstructed nor
 * refused. The table is presented as the authoritative record of what the
 * rebuild skipped, so every company that has a row in it is swept too.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const user = randomUUID();

const BACKFILL = readFileSync(
  join(process.cwd(), 'scripts/migrations/sql/659_loan_reclass_postings_backfill_rebuild.sql'),
  'utf8',
);

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
});
afterAll(async () => {
  try { await pool.query('DELETE FROM users WHERE id=$1', [user]); } finally { await pool.end(); }
});

async function inRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try { return await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}

it('sweeps a company that no longer has a loan, so its refusals cannot go stale (L4)', async () => {
  await inRollback(async (c) => {
    const company = randomUUID();
    await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K081 L4']);
    const account = async (code: string, subtype: string) => {
      const { rows } = await c.query(
        `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
           normal_balance,is_active) VALUES($1,$2,$2,'liability',$3,'credit',true) RETURNING id`,
        [company, code, subtype]);
      return rows[0].id as string;
    };
    const cp = await account('2410', 'payable');
    const lt = await account('2400', 'long_term_liability');

    // Two loans sharing a reference: the rebuild refuses both rather than
    // giving each the other's history.
    const loans: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      await c.query(
        `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,
           fixed_rate,gl_account_id,current_portion_account_id,status)
         VALUES($1,$2,'LN-STALE',100000,'2026-01-31',12,'FIXED',12,$3,$4,'active')`,
        [id, company, lt, cp]);
      loans.push(id);
    }
    const je = randomUUID();
    const narrative = 'Reclassification – loan LN-STALE for 202602';
    await c.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
         source,created_by) VALUES($1,$2,$3,'2026-02-28',$4,'posted','manual',$5)`,
      [je, company, `JE-${je.slice(0, 8)}`, narrative, user]);
    for (const [acct, debit, credit] of [[lt, 50_000, 0], [cp, 0, 50_000]] as const) {
      await c.query(
        `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit,description)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), company, je, acct, debit, credit, narrative]);
    }

    await c.query(BACKFILL);
    const first = await c.query(
      'SELECT reason FROM loan_reclass_backfill_refusals WHERE company_id=$1', [company]);
    expect(first.rows.map((r) => r.reason)).toEqual(['reference is shared by 2 loans']);

    // The company's last loan goes away; the journal and the refusal stay.
    await c.query('DELETE FROM loans WHERE company_id=$1', [company]);

    await c.query(BACKFILL);
    const second = await c.query(
      'SELECT reason FROM loan_reclass_backfill_refusals WHERE company_id=$1', [company]);
    // Driven from `loans` alone this row is untouched and still claims a
    // conflict between two loans that no longer exist.
    expect(second.rows.map((r) => r.reason)).toEqual(['no loan carries this reference']);
  });
});

/**
 * Round-4 L3. The WARNING is built with `string_agg` over the refusals, and a
 * tenant with thousands of unresolvable references would otherwise produce one
 * multi-thousand-line string held whole in memory and printed line by line.
 * Show 50 and point at the durable table, which keeps every row.
 */
it('bounds the refusal WARNING at 50 lines and says how many more there are (L3)', async () => {
  await inRollback(async (c) => {
    const company = randomUUID();
    await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K081 L3']);
    const { rows: acc } = await c.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
         normal_balance,is_active) VALUES($1,'2410','2410','liability','payable','credit',true)
       RETURNING id`, [company]);
    const cp = acc[0].id as string;
    // One loan, so the company is swept; 51 journals naming references that no
    // loan carries, each a distinct refusal line.
    await c.query(
      `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,
         fixed_rate,gl_account_id,current_portion_account_id,status)
       VALUES($1,$2,'LN-REAL',100000,'2026-01-31',12,'FIXED',12,$3,$3,'active')`,
      [randomUUID(), company, cp]);
    for (let i = 0; i < 51; i++) {
      const je = randomUUID();
      const narrative = `Reclassification – loan MISSING-${String(i).padStart(3, '0')} for 202602`;
      await c.query(
        `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
           source,created_by) VALUES($1,$2,$3,'2026-02-28',$4,'posted','manual',$5)`,
        [je, company, `JE-${je.slice(0, 8)}`, narrative, user]);
    }

    const warnings: string[] = [];
    const listener = (n: { severity?: string; message?: string }) => {
      if (n.severity === 'WARNING') warnings.push(String(n.message ?? ''));
    };
    c.on('notice', listener);
    try { await c.query(BACKFILL); } finally { c.removeListener('notice', listener); }

    const mine = warnings.filter((w) => w.includes(company));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.split('\n').filter((l) => l.startsWith(`company_id=${company}`))).toHaveLength(50);
    expect(mine[0]).toContain('… and 1 more; see loan_reclass_backfill_refusals');
    // Every one of them is still in the table.
    const { rows } = await c.query(
      'SELECT COUNT(*)::int AS n FROM loan_reclass_backfill_refusals WHERE company_id=$1', [company]);
    expect(rows[0].n).toBe(51);
  });
});
