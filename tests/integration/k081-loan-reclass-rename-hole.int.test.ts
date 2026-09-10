/**
 * K-081 review round 5 — M1 and M2, against the migration files themselves.
 *
 * M1: migration 659 resolves a loan per JOURNAL. A loan whose `reference`
 * changed between two closes therefore has its earlier journals refused ("no
 * loan carries this reference") while its later ones still reconstruct, so the
 * running sum starts at the rename. The recorded prior is then LOWER than what
 * the current-portion account holds and the next close journals
 * `target − understated_prior` — a fabricated movement, posted silently. That
 * is the defect 659 exists to eliminate, in a different guise.
 *
 * M2: migration 645's backfill is the defective reconstruction 659 replaces,
 * and it is not idempotent. On a database that has run 659 but lost its
 * schema_migrations rows, re-running 645 writes those rows back stamped with
 * the 'app' default 659 leaves behind — and 659 only ever deletes its own
 * 'backfill' rows, so nothing can clear them again.
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

const migration = (file: string) =>
  readFileSync(join(process.cwd(), 'scripts/migrations/sql', file), 'utf8');
const REBUILD = migration('659_loan_reclass_postings_backfill_rebuild.sql');
const ORIGINAL_BACKFILL = migration('645_loan_reclass_postings.sql');

interface Ctx { company: string; cp: string; lt: string }

async function account(c: PoolClient, company: string, code: string, subtype: string) {
  const { rows } = await c.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active) VALUES($1,$2,$3,'liability',$4,'credit',true) RETURNING id`,
    [company, code, `K081r5 ${code}`, subtype]);
  return rows[0].id as string;
}

async function seedCompany(c: PoolClient, label: string): Promise<Ctx> {
  const company = randomUUID();
  await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, `K081r5 ${label}`]);
  return {
    company,
    cp: await account(c, company, '2410', 'payable'),
    lt: await account(c, company, '2400', 'long_term_liability'),
  };
}

async function seedLoan(c: PoolClient, ctx: Ctx, reference: string | null, cp?: string) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,current_portion_account_id,status)
     VALUES($1,$2,$3,100000,'2026-01-31',12,'FIXED',12,$4,$5,'active')`,
    [id, ctx.company, reference, ctx.lt, cp ?? ctx.cp]);
  return id;
}

/** One posted reclass journal exactly as `closeLoanPeriod` narrates it. */
async function seedReclassJournal(
  c: PoolClient, ctx: Ctx, key: string, yyyymm: string, amount: number, cpAccount?: string,
) {
  const id = randomUUID();
  const narrative = `Reclassification – loan ${key} for ${yyyymm}`;
  const cp = cpAccount ?? ctx.cp;
  await c.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
       source,created_by) VALUES($1,$2,$3,$4,$5,'posted','manual',$6)`,
    [id, ctx.company, `JE-${id.slice(0, 8)}`,
      `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-28`, narrative, user]);
  for (const [acct, debit, credit] of [[ctx.lt, amount, 0], [cp, 0, amount]] as const) {
    await c.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit,description)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), ctx.company, id, acct, debit, credit, narrative]);
  }
  return id;
}

async function recorded(c: PoolClient, company: string) {
  const { rows } = await c.query(
    `SELECT loan_id, yyyymm, st_liability::float8 AS st, source FROM loan_reclass_postings
      WHERE company_id=$1 ORDER BY loan_id, yyyymm`, [company]);
  return rows as { loan_id: string; yyyymm: string; st: number; source: string }[];
}

async function refusals(c: PoolClient, company: string) {
  const { rows } = await c.query(
    `SELECT loan_key, reason FROM loan_reclass_backfill_refusals
      WHERE company_id=$1 ORDER BY loan_key`, [company]);
  return rows as { loan_key: string | null; reason: string }[];
}

/** Net credit the general ledger actually holds on one account. */
async function glNet(c: PoolClient, company: string, accountId: string) {
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(credit - debit),0)::float8 AS net FROM gl_journal_lines
      WHERE company_id=$1 AND gl_account_id=$2`, [company, accountId]);
  return rows[0].net as number;
}

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

it('refuses a loan renamed between two closes instead of recording half its history (M1)', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'M1');
    await seedLoan(c, ctx, 'PRB-1');
    // The 202602 close ran while the loan was still OLD-1; the reference was
    // renamed through updateLoan before the 202603 close.
    await seedReclassJournal(c, ctx, 'OLD-1', '202602', 100_000);
    await seedReclassJournal(c, ctx, 'PRB-1', '202603', 92_000);

    await c.query(REBUILD);

    // The general ledger holds 192 000. Recording 92 000 would make the next
    // close journal a fabricated 100 000 movement nobody was told about.
    expect(await glNet(c, ctx.company, ctx.cp)).toBeCloseTo(192_000, 2);
    expect(await recorded(c, ctx.company)).toEqual([]);
    expect(await refusals(c, ctx.company)).toEqual([
      { loan_key: 'OLD-1', reason: 'no loan carries this reference' },
      { loan_key: 'PRB-1',
        reason: 'an unattributable reclass journal moved this loan\'s current-portion account, '
          + 'so its reconstructed prior would start mid-history' },
    ]);
  });
});

it('refuses only the loans on the account the orphan journal moved', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'SPLIT');
    const other = await account(c, ctx.company, '2411', 'payable');
    await seedLoan(c, ctx, 'PRB-2');                       // on ctx.cp — renamed
    const clean = await seedLoan(c, ctx, 'LN-CLEAN', other); // on its own account
    await seedReclassJournal(c, ctx, 'OLD-2', '202602', 100_000);
    await seedReclassJournal(c, ctx, 'PRB-2', '202603', 92_000);
    await seedReclassJournal(c, ctx, 'LN-CLEAN', '202603', 70_000, other);

    await c.query(REBUILD);

    // The orphan never touched `other`, so LN-CLEAN's history has no hole in
    // it and refusing it would be a needless overstatement at its next close.
    expect(await recorded(c, ctx.company)).toEqual([
      { loan_id: clean, yyyymm: '202603', st: 70_000, source: 'backfill' },
    ]);
  });
});

it('refuses a loan whose account a description it cannot parse moved', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'UNPARSED');
    await seedLoan(c, ctx, 'LN-U');
    await seedReclassJournal(c, ctx, 'LN-U', '202603', 92_000);
    // A hyphen where closeLoanPeriod writes an en dash — the same movement,
    // narrated by a hand-written or imported entry the parse rejects. The hole
    // it leaves in the loan's history is identical to a rename's.
    const id = randomUUID();
    await c.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
         source,created_by) VALUES($1,$2,$3,'2026-02-28',$4,'posted','manual',$5)`,
      [id, ctx.company, `JE-${id.slice(0, 8)}`,
        'Reclassification - loan LN-U for 202602', user]);
    for (const [acct, debit, credit] of [[ctx.lt, 100_000, 0], [ctx.cp, 0, 100_000]] as const) {
      await c.query(
        `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
         VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), ctx.company, id, acct, debit, credit]);
    }

    await c.query(REBUILD);

    expect(await glNet(c, ctx.company, ctx.cp)).toBeCloseTo(192_000, 2);
    expect(await recorded(c, ctx.company)).toEqual([]);
  });
});

it('refuses only the loans an ambiguous reference could name', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'AMBIG');
    await seedLoan(c, ctx, 'DUP');
    await seedLoan(c, ctx, 'DUP');
    const solo = await seedLoan(c, ctx, 'SOLO');
    await seedReclassJournal(c, ctx, 'DUP', '202602', 100_000);
    await seedReclassJournal(c, ctx, 'SOLO', '202603', 70_000);

    await c.query(REBUILD);

    // Every loan here shares one current-portion account, but the ambiguous
    // key names only the two DUPs — SOLO's own history is complete.
    expect(await recorded(c, ctx.company)).toEqual([
      { loan_id: solo, yyyymm: '202603', st: 70_000, source: 'backfill' },
    ]);
  });
});

it('refuses a renamed loan under the tenant that owns it and no other', async () => {
  await inRollback(async (c) => {
    const one = await seedCompany(c, 'T1');
    const two = await seedCompany(c, 'T2');
    await seedLoan(c, one, 'PRB-3');
    const untouched = await seedLoan(c, two, 'PRB-3');
    await seedReclassJournal(c, one, 'OLD-3', '202602', 100_000);
    await seedReclassJournal(c, one, 'PRB-3', '202603', 92_000);
    await seedReclassJournal(c, two, 'PRB-3', '202603', 55_000);

    await c.query(REBUILD);

    expect(await recorded(c, one.company)).toEqual([]);
    expect(await recorded(c, two.company)).toEqual([
      { loan_id: untouched, yyyymm: '202603', st: 55_000, source: 'backfill' },
    ]);
    expect(await refusals(c, two.company)).toEqual([]);
  });
});

it('does not resurrect 645\'s reconstruction on a database that already ran 659 (M2)', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'M2');
    // The exact shape 645 gets wrong: two loans sharing a reference, one
    // journal. 645 wrote 100 000 for BOTH of them.
    await seedLoan(c, ctx, 'LN-DUP');
    await seedLoan(c, ctx, 'LN-DUP');
    await seedReclassJournal(c, ctx, 'LN-DUP', '202602', 100_000);

    await c.query(REBUILD);
    expect(await recorded(c, ctx.company)).toEqual([]);

    // A runner whose schema_migrations rows were lost re-applies 645.
    await c.query(ORIGINAL_BACKFILL);

    // Nothing came back — and in particular nothing stamped 'app', which 659
    // would never be able to delete again.
    expect(await recorded(c, ctx.company)).toEqual([]);
  });
});

it('still backfills on a database that has never run 659', async () => {
  await inRollback(async (c) => {
    const ctx = await seedCompany(c, 'FRESH');
    const loan = await seedLoan(c, ctx, 'LN-FRESH');
    await seedReclassJournal(c, ctx, 'LN-FRESH', '202602', 100_000);

    // Rewind the fixture to the state 645 ships into on a fresh database.
    // Rolled back with the rest of the transaction.
    await c.query('ALTER TABLE loan_reclass_postings DROP COLUMN source');
    await c.query(ORIGINAL_BACKFILL);

    const { rows } = await c.query(
      `SELECT yyyymm, st_liability::float8 AS st FROM loan_reclass_postings
        WHERE company_id=$1 AND loan_id=$2`, [ctx.company, loan]);
    expect(rows).toEqual([{ yyyymm: '202602', st: 100_000 }]);
  });
});
