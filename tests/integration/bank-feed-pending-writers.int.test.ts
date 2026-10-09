/**
 * Task 3 — set-based bank writers must select only `feed_state = 'posted'`
 * rows. A pending row matching their status/account predicate would otherwise
 * hit migration 675's BEFORE UPDATE trigger and 500 the whole operation
 * (BANK_TX_FEED_GUARD). Each writer below is exercised against one posted and
 * one pending row on the same account; the pending row must come out
 * unchanged and no call may throw.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();
let postedId = '';
let pendingId = '';
let journalEntryId = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFPW company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'1110','BFPW Bank','asset','debit','bank')`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
  // Two posted GL lines the auto-match candidate SELECT can pair against:
  // same amount as the seeded bank rows (42.50), same date, so runAutoMatch's
  // tier 2 (amount + date within 3 days) scores 0.9 — clears
  // autoMatchTransactions's `>= 0.9` bar and calls matchTransaction. TWO lines
  // (not one) so neither bank row is starved of a candidate by the other
  // claiming the only free line first: with the predicate removed, both the
  // posted and pending rows become candidates and each independently finds a
  // free line, so the pending one always reaches matchTransaction (Task 2's
  // locked mutator), which throws BankTransactionNotPostedError before its
  // first write — a throw that escapes runAutoMatch's race-skip catch (it is
  // neither BankTransactionAllocatedError, BankTransactionLockTimeoutError,
  // BankMatchTargetError('LINE_CLAIMED'), nor BankMatchUnavailableError).
  const je = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_date,description,status,created_by)
     VALUES($1,'2026-09-02','BFPW auto-match seed','posted',$2) RETURNING id`, [company, user]);
  journalEntryId = String(je.rows[0].id);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id)
     VALUES($1,$2,42.50,0,$3), ($1,$2,42.50,0,$3)`, [journalEntryId, bank, company]);
});

afterAll(async () => {
  try {
    // bank_transactions.reconciliation_id FKs bank_reconciliations with no
    // cascade — startReconciliation's test leaves the posted row pointing at
    // a reconciliation, so the reconciliation must go only after the row does.
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function seed(): Promise<void> {
  // Same FK ordering constraint as afterAll above.
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
  const ins = (state: string, pid: string | null) => pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-02',-42.5,'BFPW WOOLWORTHS',$3,$4,$5) RETURNING id`,
    [company, bank, pid ? conn : null, pid, state]);
  postedId = String((await ins('posted', null)).rows[0].id);
  pendingId = String((await ins('pending', `pend-${crypto.randomUUID()}`)).rows[0].id);
}

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function pendingUntouched(): Promise<void> {
  const { rows } = await pool.query(
    'SELECT status, reconciliation_id, feed_state FROM bank_transactions WHERE id=$1', [pendingId]);
  expect(rows[0]).toEqual({ status: 'imported', reconciliation_id: null, feed_state: 'pending' });
}

describe('set-based writers leave a pending feed row alone', () => {
  it('bulkAcceptTransactions', async () => {
    await seed();
    const { bulkAcceptTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const n = await inRequest(() => bulkAcceptTransactions(company, [postedId, pendingId]));
    expect(n).toBe(1);
    await pendingUntouched();
  });

  it('deleteTransactions', async () => {
    await seed();
    const { deleteTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const n = await inRequest(() => deleteTransactions(company, [postedId, pendingId]));
    expect(n).toBe(1);
    await pendingUntouched();
  });

  it('startReconciliation', async () => {
    await seed();
    const { startReconciliation } = await import('@/modules/accounting/services/bank/bankReconciliationService');
    await inRequest(() => startReconciliation(company, bank, '2026-09-30', 0, user));
    await pendingUntouched();
  });

  it('suggestion rules', async () => {
    await seed();
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,
         gl_account_id,is_active,auto_create_entry,priority)
       VALUES($1,'BFPW rule','description','contains','WOOLWORTHS',$2,true,false,1)`, [company, bank]);
    const { applySuggestionRules } = await import('@/modules/accounting/services/bank/bankRulesSuggestionPass');
    const rules = (await pool.query('SELECT * FROM bank_categorisation_rules WHERE company_id=$1', [company])).rows;
    const entries = await inRequest(() => applySuggestionRules(company, bank, rules));
    expect(entries.map((e) => e.bankTxId)).not.toContain(pendingId);
  });

  it('autoMatchTransactions does not throw on a pending row', async () => {
    await seed();
    const { autoMatchTransactions } = await import('@/modules/accounting/services/bank/bankAutoMatchService');
    await inRequest(() => autoMatchTransactions(company, bank, undefined, user));
    await pendingUntouched();
  });
});
