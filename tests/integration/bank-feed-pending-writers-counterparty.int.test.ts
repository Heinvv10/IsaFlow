/**
 * Task 3 (fix round 1, finding 3) — fixture coverage for
 * `autoLinkCounterpartyTransfer`'s candidate SELECT and UPDATE, both of which
 * now carry `feed_state = 'posted'`.
 *
 * The candidate query picks the SINGLE closest-dated free row
 * (`ORDER BY ... LIMIT 1`), so a pending row that is a closer date match than
 * a valid posted one can starve the posted row of its own link: without the
 * predicate, the query would pick the (closer) pending row, the UPDATE would
 * trip migration 675's trigger, and `autoLinkCounterpartyTransfer`'s
 * best-effort catch swallows that — logging a warning and leaving BOTH rows
 * unlinked, silently, with no throw the caller could see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { autoLinkCounterpartyTransfer } from '@/modules/accounting/services/bank/bankTransferAutoLink';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const conn = crypto.randomUUID();
const sourceBank = crypto.randomUUID();
const counterpartyBank = crypto.randomUUID();
const journalEntryId = crypto.randomUUID();
const counterpartyLineId = crypto.randomUUID();
const AMOUNT = 42.5; // the source (allocated) leg's signed amount
let postedId = '';
let pendingId = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFPW counterparty co']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'BFXS1','BFPW source bank','asset','debit','bank'),
           ($3,$2,'BFXS2','BFPW counterparty bank','asset','debit','bank')`,
    [sourceBank, company, counterpartyBank]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, counterpartyBank]);
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by)
     VALUES($1,$2,'2026-09-02','BFPW counterparty JE','posted',$3)`, [journalEntryId, company, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,${AMOUNT},0)`, [counterpartyLineId, company, journalEntryId, counterpartyBank]);
  // Pending row: 0 days from the source date (the closer match).
  // Posted row: 1 day from the source date — still within the ±2-day window,
  // but only reachable once the pending row is excluded.
  const posted = await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status,feed_state)
     VALUES($1,$2,'2026-09-03',${-AMOUNT},'BFPW counterparty posted','imported','posted') RETURNING id`,
    [company, counterpartyBank]);
  postedId = String(posted.rows[0].id);
  const pending = await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-02',${-AMOUNT},'BFPW counterparty pending','imported',$3,$4,'pending') RETURNING id`,
    [company, counterpartyBank, conn, `pend-${crypto.randomUUID()}`]);
  pendingId = String(pending.rows[0].id);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('autoLinkCounterpartyTransfer — pending candidate excluded', () => {
  it('links the further-dated posted row, not the closer pending one', async () => {
    await autoLinkCounterpartyTransfer({
      companyId: company,
      bankTxId: crypto.randomUUID(),
      bankAccountId: sourceBank,
      counterpartyAccountId: counterpartyBank,
      journalEntryId,
      amount: AMOUNT,
      txDate: '2026-09-02',
      allocatedEntityName: null,
    });

    const { rows: postedRows } = await pool.query(
      'SELECT status, matched_journal_line_id FROM bank_transactions WHERE id=$1', [postedId]);
    expect(postedRows[0]).toEqual({ status: 'allocated', matched_journal_line_id: counterpartyLineId });

    const { rows: pendingRows } = await pool.query(
      'SELECT status, matched_journal_line_id, feed_state FROM bank_transactions WHERE id=$1', [pendingId]);
    expect(pendingRows[0]).toEqual({ status: 'imported', matched_journal_line_id: null, feed_state: 'pending' });
  });
});
