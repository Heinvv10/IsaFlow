/**
 * K-081 review round 2 — migration 659's backfill, executed verbatim.
 *
 * The backfill seeds the `prior` every subsequent reclass journal is computed
 * from, once, on every tenant. Migration 645's version identified a loan by
 * rebuilding its narrative string and matching the line on the loan's CURRENT
 * current-portion account, and neither half of that key is unique: two loans
 * sharing a `reference` each absorbed the other's journals (H1), and two
 * reclass journals in one month collapsed to whichever the window function
 * happened to order first (M3). Both defects end the same way — closeLoanPeriod
 * reads the wrong prior and posts a fabricated movement to the general ledger.
 *
 * Every assertion below runs the `DO` block out of the migration file itself,
 * inside a transaction that is rolled back.
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

/** The migration's own `DO` block — never a copy that can drift from it. */
const BACKFILL = (() => {
  const sql = readFileSync(
    join(process.cwd(), 'scripts/migrations/sql/659_loan_reclass_postings_backfill_rebuild.sql'),
    'utf8',
  );
  const start = sql.indexOf('DO $$');
  if (start < 0) throw new Error('migration 659 no longer contains a DO block');
  return sql.slice(start);
})();

interface Ctx {
  company: string;
  cp: string;
  lt: string;
}

/** A company with a current-portion and a long-term liability account. */
async function seedCompany(c: PoolClient, label: string): Promise<Ctx> {
  const company = randomUUID();
  await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, `K081bf ${label}`]);
  const account = async (code: string, name: string, subtype: string) => {
    const { rows } = await c.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
         normal_balance,is_active) VALUES($1,$2,$3,'liability',$4,'credit',true) RETURNING id`,
      [company, code, `${label} ${name}`, subtype]);
    return rows[0].id as string;
  };
  return {
    company,
    cp: await account('2410', 'Loan current portion', 'payable'),
    lt: await account('2400', 'Loan liability', 'long_term_liability'),
  };
}

async function seedLoan(c: PoolClient, ctx: Ctx, reference: string | null): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,current_portion_account_id,status)
     VALUES($1,$2,$3,100000,'2026-01-31',12,'FIXED',12,$4,$5,'active')`,
    [id, ctx.company, reference, ctx.lt, ctx.cp]);
  return id;
}

/**
 * One posted reclass journal exactly as `closeLoanPeriod` narrates it:
 * CR the current-portion account, DR the long-term account, by `amount`.
 */
async function seedReclassJournal(
  c: PoolClient, ctx: Ctx, key: string, yyyymm: string, amount: number,
  opts: { cpAccount?: string; reversed?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const narrative = `Reclassification – loan ${key} for ${yyyymm}`;
  const cp = opts.cpAccount ?? ctx.cp;
  await c.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
       source,created_by,reversed_at)
     VALUES($1,$2,$3,$4,$5,'posted','manual',$6,$7)`,
    [id, ctx.company, `JE-${id.slice(0, 8)}`, `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-28`,
      narrative, user, opts.reversed ? new Date() : null]);
  // A falling current portion posts the legs the other way round rather than a
  // negative amount — gl_journal_lines refuses negatives.
  const legs = amount >= 0
    ? ([[ctx.lt, amount, 0], [cp, 0, amount]] as const)
    : ([[cp, -amount, 0], [ctx.lt, 0, -amount]] as const);
  for (const [acct, debit, credit] of legs) {
    await c.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit,description)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), ctx.company, id, acct, debit, credit, narrative]);
  }
  return id;
}

async function recorded(c: PoolClient, company: string) {
  const { rows } = await c.query(
    `SELECT loan_id, yyyymm, st_liability::float8 AS st FROM loan_reclass_postings
      WHERE company_id=$1 ORDER BY loan_id, yyyymm`, [company]);
  return rows as { loan_id: string; yyyymm: string; st: number }[];
}

/** Run `fn` against a rolled-back transaction, so the fixture keeps no rows. */
async function inRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses two loans that share a reference instead of giving each the other history (H1)', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'H1');
    const a = await seedLoan(c, ctx, 'LN-1');
    const b = await seedLoan(c, ctx, 'LN-1');
    // ONE journal, posted for A only. 645 wrote 202602 = 100 000 for BOTH.
    await seedReclassJournal(c, ctx, 'LN-1', '202602', 100_000);

    await c.query(BACKFILL);

    // Neither loan gets a fabricated prior: the key is ambiguous, so it is
    // refused. Their next close reclassifies the full current portion — an
    // overstatement a human can see, not a movement nobody can trace.
    expect(await recorded(c, ctx.company)).toEqual([]);
    expect([a, b]).toHaveLength(2);
  });
});

it('reconstructs an unambiguous loan alongside the refused pair', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'MIX');
    await seedLoan(c, ctx, 'DUP');
    await seedLoan(c, ctx, 'DUP');
    const clean = await seedLoan(c, ctx, 'LN-CLEAN');
    await seedReclassJournal(c, ctx, 'DUP', '202602', 100_000);
    await seedReclassJournal(c, ctx, 'LN-CLEAN', '202602', 70_000);
    await seedReclassJournal(c, ctx, 'LN-CLEAN', '202603', -8_000);

    await c.query(BACKFILL);

    // Running balance, so March records the compounded 62 000, not -8 000.
    expect(await recorded(c, ctx.company)).toEqual([
      { loan_id: clean, yyyymm: '202602', st: 70_000 },
      { loan_id: clean, yyyymm: '202603', st: 62_000 },
    ]);
  });
});

it('sums two reclass journals in the same month instead of keeping one (M3)', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'M3');
    const loan = await seedLoan(c, ctx, 'LN-M3');
    await seedReclassJournal(c, ctx, 'LN-M3', '202602', 100_000);
    await seedReclassJournal(c, ctx, 'LN-M3', '202602', 92_000);

    await c.query(BACKFILL);

    // The GL holds 192 000 on the current-portion account; 645 recorded 92 000
    // and stranded the other 100 000 forever.
    const { rows } = await c.query(
      `SELECT COALESCE(SUM(l.credit - l.debit),0)::float8 AS net FROM gl_journal_lines l
        WHERE l.company_id=$1 AND l.gl_account_id=$2`, [ctx.company, ctx.cp]);
    expect(rows[0].net).toBeCloseTo(192_000, 2);
    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: loan, yyyymm: '202602', st: 192_000 }]);
  });
});

it('refuses a loan whose current-portion account was re-pointed after a close (L3)', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'L3');
    await seedLoan(c, ctx, 'LN-L3');
    const { rows } = await c.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
         normal_balance,is_active) VALUES($1,'2411','Old current portion','liability','payable','credit',true)
       RETURNING id`, [ctx.company]);
    // The close posted against the OLD account; the loan now points elsewhere.
    await seedReclassJournal(c, ctx, 'LN-L3', '202602', 100_000, { cpAccount: rows[0].id });

    await c.query(BACKFILL);

    expect(await recorded(c, ctx.company)).toEqual([]);
  });
});

it('ignores a reversed reclass entry (L4)', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'L4');
    const loan = await seedLoan(c, ctx, 'LN-L4');
    await seedReclassJournal(c, ctx, 'LN-L4', '202602', 100_000);
    await seedReclassJournal(c, ctx, 'LN-L4', '202603', 40_000, { reversed: true });

    await c.query(BACKFILL);

    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: loan, yyyymm: '202602', st: 100_000 }]);
  });
});

it('writes nothing under another tenant and reconstructs each independently', async () => {
  await inRollback(async (c) => {
    const one = await seedCompany(c, 'T1');
    const two = await seedCompany(c, 'T2');
    const loanOne = await seedLoan(c, one, 'SHARED-REF');
    const loanTwo = await seedLoan(c, two, 'SHARED-REF');
    await seedReclassJournal(c, one, 'SHARED-REF', '202602', 100_000);
    await seedReclassJournal(c, two, 'SHARED-REF', '202602', 55_000);

    await c.query(BACKFILL);

    // The same reference in two companies is not ambiguous — resolution is
    // per company — and neither figure leaks into the other.
    expect(await recorded(c, one.company))
      .toEqual([{ loan_id: loanOne, yyyymm: '202602', st: 100_000 }]);
    expect(await recorded(c, two.company))
      .toEqual([{ loan_id: loanTwo, yyyymm: '202602', st: 55_000 }]);
  });
});

it('is idempotent: a second run reproduces the same rows', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'IDEM');
    const loan = await seedLoan(c, ctx, 'LN-IDEM');
    await seedReclassJournal(c, ctx, 'LN-IDEM', '202602', 100_000);
    await seedReclassJournal(c, ctx, 'LN-IDEM', '202603', -8_000);

    await c.query(BACKFILL);
    const first = await recorded(c, ctx.company);
    await c.query(BACKFILL);

    expect(first).toEqual([
      { loan_id: loan, yyyymm: '202602', st: 100_000 },
      { loan_id: loan, yyyymm: '202603', st: 92_000 },
    ]);
    expect(await recorded(c, ctx.company)).toEqual(first);
  });
});

it('aborts, naming the tenant, once a close has written to the table', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'GUARD');
    const loan = await seedLoan(c, ctx, 'LN-GUARD');
    await seedReclassJournal(c, ctx, 'LN-GUARD', '202602', 100_000);
    await c.query(
      `INSERT INTO loan_reclass_postings(company_id,loan_id,yyyymm,st_liability,created_at)
       VALUES($1,$2,'202602',100000,now() - interval '1 hour')`, [ctx.company, loan]);
    await c.query(
      `INSERT INTO loan_period_locks(company_id,yyyymm,locked_at,locked_by)
       VALUES($1,'202602',now(),$2)`, [ctx.company, user]);

    await expect(c.query(BACKFILL)).rejects.toThrow(new RegExp(ctx.company));
  });
});
