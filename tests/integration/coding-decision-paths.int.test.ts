/**
 * The learning-loop log written by the SERVICES themselves, against a real schema: the three ways the
 * route-level wiring misreported (round-1 review of PR 1).
 *
 *   1. A match is judged by what the matched journal posts: the suggested account -> accepted, another ->
 *      recoded (it used to be recoded every time).
 *   2. A person's saved pick (save_selection rewrites suggested_gl_account_id and keeps the old strategy and
 *      confidence) that the gate sweep then posts is the person's recode of ISAFlow's suggestion, never
 *      ISAFlow auto-accepting its own suggestion, and the original suggestion is kept.
 *   3. A reverse straight through the service (as the MCP tools call it) undoes the auto-post it reverses;
 *      a person reversing their OWN later allocation never lands on an older auto-post's row.
 *
 * Every case runs in one request-shaped transaction on the pool role (as k140's sweep suite) and is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { pool, seedUser, teardownCompanies } from './learning-loop.helpers';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { matchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { recordSuggestionsShown } from '@/modules/accounting/services/bank/codingDecisionLog';

assertDisposable();

const co = crypto.randomUUID();
const bank = crypto.randomUUID();
const expense = crypto.randomUUID();
const other = crypto.randomUUID();
let user = '';

const today = new Date();
const monthStart = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)).toISOString().slice(0, 10);
const monthEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0)).toISOString().slice(0, 10);
const day = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 2)).toISOString().slice(0, 10);
const period = crypto.randomUUID();

interface Decision {
  outcome: string; was_auto_posted: boolean; decided_by: string | null; suggestion_source: string;
  suggested_gl: string | null; final_gl: string | null; decided_at: Date | null; posted_journal_entry_id: string | null;
}

async function inRequest<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, userId: user, companyId: co, claims: {} } as never, () => fn(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** An imported -100 line carrying ISAFlow's `pattern` suggestion (columns + its pending decision). */
async function suggestedLine(c: PoolClient, gl: string): Promise<string> {
  const id = (await c.query<{ id: string }>(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
       suggested_gl_account_id, suggested_confidence, suggested_strategy)
     VALUES ($1, $2, $3::DATE, -100, 'ENGEN FUEL', 'imported', $4, 0.99, 'pattern') RETURNING id`,
    [co, bank, day, gl])).rows[0]!.id;
  await recordSuggestionsShown(co, [{ txId: id, source: 'pattern', glAccountId: gl, confidence: 0.99 }]);
  return id;
}

/** A posted journal: DR `contra` 100 / CR bank 100. Returns its bank line. */
async function postedJournal(c: PoolClient, contra: string): Promise<string> {
  const je = crypto.randomUUID();
  const bankLine = crypto.randomUUID();
  await c.query(
    `INSERT INTO gl_journal_entries (id, company_id, entry_date, description, status, created_by, fiscal_period_id,
       posted_at, posted_by, source)
     VALUES ($1, $2, $3::DATE, 'LL match target', 'posted', $4, $5, now(), $4, 'manual')`, [je, co, day, user, period]);
  await c.query(
    `INSERT INTO gl_journal_lines (id, company_id, journal_entry_id, gl_account_id, debit, credit)
     VALUES ($1, $2, $3, $4, 0, 100), (gen_random_uuid(), $2, $3, $5, 100, 0)`, [bankLine, co, je, bank, contra]);
  return bankLine;
}

const decisionsOf = async (c: PoolClient, txId: string): Promise<Decision[]> => (await c.query<Decision>(
  `SELECT outcome, was_auto_posted, decided_by, suggestion_source, suggested_gl_account_id::TEXT AS suggested_gl,
          final_gl_account_id::TEXT AS final_gl, decided_at, posted_journal_entry_id::TEXT AS posted_journal_entry_id
   FROM categorization_decisions WHERE company_id = $1 AND bank_transaction_id = $2 ORDER BY created_at, id`,
  [co, txId])).rows;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [co, 'LL decision paths']);
  user = await seedUser([co]);
  await pool.query(
    `INSERT INTO fiscal_periods(id, company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, $2, 'LL current', 1, 2099, $3::DATE, $4::DATE, 'open')`, [period, co, monthStart, monthEnd]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     VALUES ($1, $4, '1100', 'LL Bank', 'asset', 'bank', 'debit'),
            ($2, $4, '6100', 'LL Fuel', 'expense', 'default_expense', 'debit'),
            ($3, $4, '6200', 'LL Telephone', 'expense', NULL, 'debit')`, [bank, expense, other, co]);
  await pool.query(
    `INSERT INTO bank_auto_post_settings
       (company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_at)
     VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [co]);
}, 60_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_auto_post_settings WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await teardownCompanies([co], [user]);
  } finally {
    await pool.end();
  }
});

describe('1. a match is judged by the matched journal', () => {
  it('a journal posting the suggested account: accepted; one posting another account: recoded', async () => {
    await inRequest(async (c) => {
      const hit = await suggestedLine(c, expense);
      const miss = await suggestedLine(c, expense);
      await matchTransaction(co, hit, await postedJournal(c, expense), undefined, user);
      await matchTransaction(co, miss, await postedJournal(c, other), undefined, user);
      expect(await decisionsOf(c, hit)).toMatchObject([{ outcome: 'accepted', final_gl: expense, decided_by: user }]);
      expect(await decisionsOf(c, miss)).toMatchObject([{ outcome: 'recoded', final_gl: other, decided_by: user }]);
    });
  }, 60_000);
});

describe('2. a person\'s saved pick, posted by the gate sweep', () => {
  it('is the person\'s recode: the original suggestion kept, no auto-post row claiming it for ISAFlow', async () => {
    await inRequest(async (c) => {
      const line = await suggestedLine(c, expense);
      // save_selection: only the target moves; strategy and confidence stay (bank-transactions-action).
      await c.query('UPDATE bank_transactions SET suggested_gl_account_id = $2 WHERE id = $1', [line, other]);
      const r = await sweep(co, [line], 'categorization', user, user);
      expect(r.posted).toBe(1);
      expect(await decisionsOf(c, line)).toMatchObject([{
        outcome: 'recoded', was_auto_posted: false, decided_by: user, suggestion_source: 'pattern',
        suggested_gl: expense, final_gl: other,
      }]);
    });
  }, 60_000);

  it('the sweep posting ISAFlow\'s own open suggestion is the auto-accepted decision, journal recorded', async () => {
    await inRequest(async (c) => {
      const line = await suggestedLine(c, expense);
      expect((await sweep(co, [line], 'categorization', user, user)).posted).toBe(1);
      const [d] = await decisionsOf(c, line);
      expect(d).toMatchObject({ outcome: 'accepted', was_auto_posted: true, decided_by: null, suggested_gl: expense });
      const posted = (await c.query<{ je: string }>(
        `SELECT jl.journal_entry_id::TEXT AS je FROM bank_transactions bt
         JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id WHERE bt.id = $1`, [line])).rows[0]!.je;
      expect(d!.posted_journal_entry_id).toBe(posted);
    });
  }, 60_000);
});

describe('3. reversals reach the log through the service, and only the live auto-post moves', () => {
  it('a reverse called straight on the service (the MCP path) undoes the auto-post', async () => {
    await inRequest(async (c) => {
      const line = await suggestedLine(c, expense);
      expect((await sweep(co, [line], 'categorization', user, user)).posted).toBe(1);
      await reverseReconciledTransaction(co, line, user);
      expect(await decisionsOf(c, line)).toMatchObject([{ outcome: 'undone', was_auto_posted: true, decided_by: user }]);
    });
  }, 60_000);

  it('a stale auto-post row is not blamed for a person reversing their own later allocation', async () => {
    await inRequest(async (c) => {
      const line = (await c.query<{ id: string }>(
        `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
         VALUES ($1, $2, $3::DATE, -100, 'TELKOM', 'imported') RETURNING id`, [co, bank, day])).rows[0]!.id;
      // An auto-post an earlier path took off the books without telling the log: still reads accepted.
      await c.query(
        `INSERT INTO categorization_decisions (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id,
           was_auto_posted, auto_posted_at, posted_journal_entry_id, outcome, final_gl_account_id, decided_at)
         VALUES ($1, $2, 'rule', $3, true, '2026-01-05T08:00:00Z', gen_random_uuid(), 'accepted', $3, '2026-01-05T08:00:00Z')`,
        [co, line, expense]);
      await allocateTransaction(co, line, other, user);
      await reverseReconciledTransaction(co, line, user);
      const rows = await decisionsOf(c, line);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'accepted', decided_by: null });
      expect(new Date(rows[0]!.decided_at!).toISOString()).toBe('2026-01-05T08:00:00.000Z');
    });
  }, 60_000);
});
