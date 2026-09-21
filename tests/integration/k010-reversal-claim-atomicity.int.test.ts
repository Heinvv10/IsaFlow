/**
 * K-010 follow-up — the reversal claim must not outlive the contra it stands for.
 *
 * `reversed_at IS NOT NULL` is read as "this entry is reversed" by the audit
 * trail, by bank/agentActivityService, by items/depreciationRunPlan (which
 * EXCLUDES such an entry from a run) and by ap/supplierPaymentWorkflowService
 * (which SKIPS the reversal it owes). A claim written before the contra and
 * left behind by a crash would make every one of them describe an un-reversed
 * journal as reversed — worse than the race it closes.
 *
 * So the claim is taken inside a transaction that also carries the contra. This
 * file proves it three ways: the claim is invisible to another connection while
 * the reversal is in flight, a failed post leaves nothing behind, and the
 * in-request path (ALS-bound client, SET LOCAL lock_timeout) both serialises
 * and restores the timeout it borrowed.
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
    // Barrier sits AFTER the claim and BEFORE the contra exists — the exact
    // instant a crash would strand a claim.
    createJournalEntry: async (...args: Parameters<typeof actual.createJournalEntry>) => {
      if (barrierArmed) await new Promise<void>((release) => { barrier.push(release); });
      return actual.createJournalEntry(...args);
    },
  };
});

const { reverseJournalEntry } = await import('../../src/modules/accounting/services/gl/journalEntryPostingService');
const { als } = await import('../../src/lib/als');

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const period = crypto.randomUUID(), cash = crypto.randomUUID(), revenue = crypto.randomUUID();
const inFlight = crypto.randomUUID(), failing = crypto.randomUUID(), inRequest = crypto.randomUUID();
const dead = crypto.randomUUID();

async function seedEntry(id: string, creditAccount: string) {
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,source,description,fiscal_period_id)
    VALUES($1,$2,'2026-03-31',$3,'posted','manual','K010 atomicity',$4)`, [id, company, user, period]);
  await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
    VALUES($1,$2,$3,100,0,'cash'),($1,$2,$4,0,100,'other')`, [company, id, cash, creditAccount]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K010 atomicity fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'K010 period',1,2026,'2026-01-01','2026-12-31','open')`, [period, company]);
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
    VALUES($1,$4,'1100','K010 cash','asset','debit',3,true),
          ($2,$4,'4000','K010 revenue','revenue','credit',3,true),
          ($3,$4,'4900','K010 retired','revenue','credit',3,false)`, [cash, revenue, dead, company]);
  await seedEntry(inFlight, revenue);
  await seedEntry(inRequest, revenue);
  // Its contra will target a DEACTIVATED account, so postJournalEntry refuses
  // after createJournalEntry has already inserted the draft.
  await seedEntry(failing, dead);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[cash, revenue, dead]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

beforeEach(() => { barrier = []; barrierArmed = false; });

async function reversedAt(entryId: string) {
  const r = await pool.query('SELECT reversed_at, reversed_by FROM gl_journal_entries WHERE id=$1', [entryId]);
  return r.rows[0] as { reversed_at: Date | null; reversed_by: string | null };
}

async function contras(entryId: string) {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2', [company, entryId]);
  return r.rows[0].n as number;
}

it('does not commit the claim until the contra is posted with it', async () => {
  barrierArmed = true;
  const done = reverseJournalEntry(company, inFlight, user);
  for (let i = 0; i < 200 && barrier.length < 1; i++) await new Promise(r => setTimeout(r, 10));
  expect(barrier.length).toBe(1);

  // The claim has been written on the reversal's own connection. Read from a
  // DIFFERENT one: if it were autocommitted, a crash here would strand it and
  // nine call sites would report this un-reversed journal as reversed.
  expect((await reversedAt(inFlight)).reversed_at).toBeNull();
  expect(await contras(inFlight)).toBe(0);

  barrierArmed = false;
  barrier[0]!();
  await done;

  const settled = await reversedAt(inFlight);
  expect(settled.reversed_at).not.toBeNull();
  expect(settled.reversed_by).toBe(user);
  expect(await contras(inFlight)).toBe(1);
});

it('leaves no claim, no draft and no contra when the reversal cannot be posted', async () => {
  await expect(reverseJournalEntry(company, failing, user)).rejects.toThrow(/deactivated GL account/);

  expect((await reversedAt(failing)).reversed_at).toBeNull();
  expect(await contras(failing)).toBe(0);
  const drafts = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND status='draft'", [company]);
  expect(drafts.rows[0].n).toBe(0);

  // And the entry is still reversible — the failure must not have made it
  // permanently un-reversible, which is the state the claim risks.
  const ok = await reverseJournalEntry(company, failing, user).then(() => true, () => false);
  expect(ok).toBe(false); // still refuses (the account is still deactivated)
  expect((await reversedAt(failing)).reversed_at).toBeNull();
});

it('runs on the request transaction and restores the lock_timeout it borrowed', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('lock_timeout', '3s', true)");
    await als.run({ client, userId: user, companyId: company, claims: {} }, async () => {
      await reverseJournalEntry(company, inRequest, user);
    });

    // M4: SET LOCAL is transaction-scoped, so a claim that left 5s in place
    // would abort every later statement of this request after 5s.
    const after = await client.query("SELECT current_setting('lock_timeout') AS v");
    expect(after.rows[0].v).toBe('3s');

    // Uncommitted, so still invisible outside this connection.
    expect((await reversedAt(inRequest)).reversed_at).toBeNull();
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  expect((await reversedAt(inRequest)).reversed_at).not.toBeNull();
  expect(await contras(inRequest)).toBe(1);
});

it('refuses a second reversal raised from another request transaction', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await als.run({ client, userId: user, companyId: company, claims: {} }, () =>
      reverseJournalEntry(company, inRequest, user).then(() => 'posted', (e: Error) => e.message));
    expect(outcome).toMatch(/already reversed/);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  expect(await contras(inRequest)).toBe(1);
});
