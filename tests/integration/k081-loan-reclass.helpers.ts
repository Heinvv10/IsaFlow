/**
 * Shared fixture for the K-081 backfill suites: a tenant, its two loan
 * accounts, loans, schedule runs and posted reclass journals, all inside a
 * transaction the caller rolls back.
 *
 * The schedule matters as much as the journals since round 6: migration 659
 * only records a reconstructed current portion the loan's OWN
 * `loan_schedule_rows.st_liability` confirms, so a loan seeded without one is
 * refused by design.
 */
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

export const REBUILD = readFileSync(
  join(process.cwd(), 'scripts/migrations/sql/659_loan_reclass_postings_backfill_rebuild.sql'),
  'utf8',
);

export const ORIGINAL_BACKFILL = readFileSync(
  join(process.cwd(), 'scripts/migrations/sql/645_loan_reclass_postings.sql'),
  'utf8',
);

export interface Ctx {
  company: string;
  /** Current-portion account, shared by every loan seeded without an override. */
  cp: string;
  /** Long-term loan account. */
  lt: string;
}

export interface Harness {
  pool: Pool;
  user: string;
  /** Run `fn` against a rolled-back transaction, so the fixture keeps no rows. */
  inRollback: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
  setUp: () => Promise<void>;
  tearDown: () => Promise<void>;
}

export function harness(): Harness {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const user = randomUUID();
  return {
    pool,
    user,
    inRollback: async (fn) => {
      const c = await pool.connect();
      await c.query('BEGIN');
      try {
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    },
    setUp: async () => {
      await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
        [user, `${user}@test.local`]);
    },
    tearDown: async () => {
      try {
        await pool.query('DELETE FROM users WHERE id=$1', [user]);
      } finally { await pool.end(); }
    },
  };
}

export async function account(c: PoolClient, company: string, code: string, subtype: string) {
  const { rows } = await c.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active) VALUES($1,$2,$3,'liability',$4,'credit',true) RETURNING id`,
    [company, code, `K081 ${code}`, subtype]);
  return rows[0].id as string;
}

/** A company with a current-portion and a long-term liability account. */
export async function seedCompany(c: PoolClient, label: string): Promise<Ctx> {
  const company = randomUUID();
  await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, `K081 ${label}`]);
  return {
    company,
    cp: await account(c, company, '2410', 'payable'),
    lt: await account(c, company, '2400', 'long_term_liability'),
  };
}

export async function seedLoan(
  c: PoolClient, ctx: Ctx, reference: string | null,
  opts: { cpAccount?: string; ltAccount?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,current_portion_account_id,status)
     VALUES($1,$2,$3,100000,'2026-01-31',12,'FIXED',12,$4,$5,'active')`,
    [id, ctx.company, reference, opts.ltAccount ?? ctx.lt, opts.cpAccount ?? ctx.cp]);
  return id;
}

/**
 * One schedule run holding the current portion the close for `yyyymm` read.
 * Runs accumulate, so several of these describe a repriced loan.
 */
export async function seedScheduleRow(
  c: PoolClient, ctx: Ctx, loanId: string, yyyymm: string, stLiability: number,
): Promise<string> {
  const run = randomUUID();
  await c.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','hash')`, [run, loanId, ctx.company]);
  await c.query(
    `INSERT INTO loan_schedule_rows(run_id,period,date,opening,closing,st_liability)
     VALUES($1,1,$2,100000,90000,$3)`,
    [run, `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-28`, stLiability]);
  return run;
}

/**
 * One posted reclass journal exactly as `closeLoanPeriod` narrates it:
 * CR the current-portion account, DR the long-term account, by `amount`.
 */
export async function seedReclassJournal(
  c: PoolClient, ctx: Ctx, user: string, key: string, yyyymm: string, amount: number,
  opts: { cpAccount?: string; ltAccount?: string; reversed?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const narrative = `Reclassification – loan ${key} for ${yyyymm}`;
  const cp = opts.cpAccount ?? ctx.cp;
  const lt = opts.ltAccount ?? ctx.lt;
  await c.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
       source,created_by,reversed_at)
     VALUES($1,$2,$3,$4,$5,'posted','manual',$6,$7)`,
    [id, ctx.company, `JE-${id.slice(0, 8)}`, `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-28`,
      narrative, user, opts.reversed ? new Date() : null]);
  // A falling current portion posts the legs the other way round rather than a
  // negative amount — gl_journal_lines refuses negatives.
  const legs = amount >= 0
    ? ([[lt, amount, 0], [cp, 0, amount]] as const)
    : ([[cp, -amount, 0], [lt, 0, -amount]] as const);
  for (const [acct, debit, credit] of legs) {
    await c.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit,description)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), ctx.company, id, acct, debit, credit, narrative]);
  }
  return id;
}

export async function recorded(c: PoolClient, company: string) {
  const { rows } = await c.query(
    `SELECT loan_id, yyyymm, st_liability::float8 AS st FROM loan_reclass_postings
      WHERE company_id=$1 ORDER BY loan_id, yyyymm`, [company]);
  return rows as { loan_id: string; yyyymm: string; st: number }[];
}

export async function refusals(c: PoolClient, company: string) {
  const { rows } = await c.query(
    `SELECT loan_key, yyyymm, reason FROM loan_reclass_backfill_refusals
      WHERE company_id=$1 ORDER BY reason, loan_key`, [company]);
  return rows as { loan_key: string | null; yyyymm: string | null; reason: string }[];
}

/** Net credit the general ledger actually holds on one account. */
export async function glNet(c: PoolClient, company: string, accountId: string) {
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(credit - debit),0)::float8 AS net FROM gl_journal_lines
      WHERE company_id=$1 AND gl_account_id=$2`, [company, accountId]);
  return rows[0].net as number;
}
