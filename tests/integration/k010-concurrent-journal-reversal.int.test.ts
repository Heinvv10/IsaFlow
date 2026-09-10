/**
 * K-010 — two concurrent reversals of the same journal entry both succeed.
 *
 * reverseJournalEntry read the original with getJournalEntryById, checked
 * entry.reversedAt, then created and posted the contra and only THEN wrote
 * reversed_at. Two overlapping requests both cleared the guard and both posted
 * a contra, so the account ended at the NEGATIVE of the original, not zero.
 *
 * The interleave is deterministic: getJournalEntryById is wrapped in a barrier
 * that holds each caller immediately AFTER its unlocked read, so both requests
 * are provably holding a pre-write view of the original before either is
 * allowed to continue. The real implementation runs on both paths.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

let barrier: Array<() => void> = [];
let barrierArmed = false;
vi.mock('../../src/modules/accounting/services/gl/journalEntryCrudService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/accounting/services/gl/journalEntryCrudService')>();
  return {
    ...actual,
    getJournalEntryById: async (...args: Parameters<typeof actual.getJournalEntryById>) => {
      const entry = await actual.getJournalEntryById(...args);
      if (barrierArmed) await new Promise<void>((release) => { barrier.push(release); });
      return entry;
    },
  };
});

const { reverseJournalEntry } = await import('../../src/modules/accounting/services/gl/journalEntryPostingService');

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID(), user = crypto.randomUUID();
const period = crypto.randomUUID(), cash = crypto.randomUUID(), revenue = crypto.randomUUID();
const original = crypto.randomUUID(), sequential = crypto.randomUUID();

async function seedEntry(id: string, description: string) {
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,source,description,fiscal_period_id)
    VALUES($1,$2,'2026-03-31',$3,'posted','manual',$4,$5)`, [id, company, user, description, period]);
  await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
    VALUES($1,$2,$3,100,0,'cash'),($1,$2,$4,0,100,'revenue')`, [company, id, cash, revenue]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K010 reversal fixture', other, 'K010 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'K010 period',1,2026,'2026-01-01','2026-12-31','open')`, [period, company]);
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
    VALUES($1,$3,'1100','K010 cash','asset','debit',3,true),($2,$3,'4000','K010 revenue','revenue','credit',3,true)`, [cash, revenue, company]);
  await seedEntry(original, 'K010 original');
  await seedEntry(sequential, 'K010 sequential original');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[cash, revenue]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

beforeEach(() => { barrier = []; barrierArmed = false; });

const settle = (p: Promise<unknown>) => p.then(() => 'posted a reversal', (err: Error) => err.message);

async function bothArrived() {
  for (let i = 0; i < 200 && barrier.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  expect(barrier.length).toBe(2);
}

async function postedContras(entryId: string) {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2 AND status=$3',
    [company, entryId, 'posted']);
  return r.rows[0].n as number;
}

/** Net movement on cash from one original and every posted contra linked to it. */
async function netOnCash(entryId: string) {
  const r = await pool.query(`SELECT COALESCE(sum(l.debit-l.credit),0)::text AS net
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id=l.journal_entry_id AND e.status='posted'
    WHERE l.company_id=$1 AND l.gl_account_id=$2
      AND (e.id = $3 OR e.reversal_of_id = $3)`, [company, cash, entryId]);
  return r.rows[0].net as string;
}

async function unbalancedJournals() {
  const r = await pool.query(`SELECT count(*)::int AS n FROM (
      SELECT journal_entry_id FROM gl_journal_lines WHERE company_id=$1
      GROUP BY journal_entry_id HAVING sum(debit) <> sum(credit)) x`, [company]);
  return r.rows[0].n as number;
}

it('refuses the second of two overlapping reversals of the same entry', async () => {
  barrierArmed = true;
  const outcomes = [settle(reverseJournalEntry(company, original, user)), settle(reverseJournalEntry(company, original, user))];
  await bothArrived();

  // Both callers now hold a pre-write view of the original: neither has written
  // reversed_at. Release in arrival order — the first completes its reversal,
  // then the second resumes carrying the read it took before that write landed.
  // Sequential release also keeps the two contra INSERTs off each other, so the
  // separate JE-entry-number collision cannot mask this defect.
  barrierArmed = false;
  barrier[0]!();
  await Promise.race(outcomes);
  barrier[1]!();
  const [a, b] = await Promise.all(outcomes);

  expect([a, b].filter(o => o === 'posted a reversal')).toHaveLength(1);
  expect([a, b].find(o => o !== 'posted a reversal')).toMatch(/already reversed/);
  expect(await postedContras(original)).toBe(1);
  expect(await netOnCash(original)).toBe('0.00');
  expect(await unbalancedJournals()).toBe(0);
});

it('refuses a sequential retry of an entry already reversed', async () => {
  expect(await settle(reverseJournalEntry(company, sequential, user))).toBe('posted a reversal');
  expect(await settle(reverseJournalEntry(company, sequential, user))).toMatch(/already reversed/);
  expect(await postedContras(sequential)).toBe(1);
  expect(await netOnCash(sequential)).toBe('0.00');
  expect(await unbalancedJournals()).toBe(0);
});

it('refuses to reverse an entry belonging to another tenant and leaves it untouched', async () => {
  const before = await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE id=$1', [sequential]);
  expect(await settle(reverseJournalEntry(other, sequential, user))).toMatch(/not found/);
  const after = await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE id=$1', [sequential]);
  expect(after.rows[0].reversed_at).toEqual(before.rows[0].reversed_at);
  expect(await postedContras(sequential)).toBe(1);
  const leaked = await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [other]);
  expect(leaked.rows[0].n).toBe(0);
});
