/**
 * Migration 675's database backstop. A non-posted feed row must refuse every
 * accounting-column change whichever writer attempts it. Only pending -> posted
 * and pending -> removed are legal lifecycle moves. A processed feed row's
 * source fields must never be rewritten.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();
const journalEntry = crypto.randomUUID();
const journalLine = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BF675 company']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'1110','BF675 Bank','asset','debit','bank')`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
  // gl_journal_entries.created_by and gl_journal_lines carry no FK to users,
  // so a synthetic uuid is enough — no users fixture row needed (finding 8).
  await pool.query(
    `INSERT INTO gl_journal_entries(id,entry_date,created_by,company_id)
     VALUES($1,'2026-09-01',$2,$3)`, [journalEntry, crypto.randomUUID(), company]);
  await pool.query(
    `INSERT INTO gl_journal_lines(id,journal_entry_id,gl_account_id,company_id)
     VALUES($1,$2,$3,$4)`, [journalLine, journalEntry, bank, company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally { await pool.end(); }
});

async function feedRow(state: 'pending' | 'posted' | 'removed', providerId: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-01',-100,'BF675 row',$3,$4,$5) RETURNING id`,
    [company, bank, conn, providerId, state]);
  return String(rows[0].id);
}

describe('migration 675 — feed lifecycle backstop', () => {
  it('defaults existing and manual rows to posted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description)
       VALUES($1,$2,'2026-09-01',-5,'manual') RETURNING feed_state`, [company, bank]);
    expect(rows[0].feed_state).toBe('posted');
  });

  it('rejects a non-posted row without feed identity', async () => {
    await expect(pool.query(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,feed_state)
       VALUES($1,$2,'2026-09-01',-5,'orphan pending','pending')`, [company, bank],
    )).rejects.toThrow(/bank_tx_feed_identity_required/);
  });

  it('rejects a second row with the same connection + provider id', async () => {
    await feedRow('posted', 'dup-1');
    await expect(feedRow('posted', 'dup-1')).rejects.toThrow(/uq_bank_tx_feed_identity/);
  });

  it.each([
    ['status', "status = 'matched'"],
    ['status to excluded', "status = 'excluded'"],
    ['allocation_type', "allocation_type = 'account'"],
    ['provisional_je_id', 'provisional_je_id = gen_random_uuid()'],
  ])('refuses %s on a pending row', async (_label, setClause) => {
    const id = await feedRow('pending', `p-${crypto.randomUUID()}`);
    await expect(pool.query(`UPDATE bank_transactions SET ${setClause} WHERE id=$1`, [id]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('allows suggestion and note columns on a pending row', async () => {
    const id = await feedRow('pending', `s-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET notes='n', suggested_vat_code='standard' WHERE id=$1", [id]);
    const { rows } = await pool.query('SELECT notes, suggested_vat_code FROM bank_transactions WHERE id=$1', [id]);
    expect(rows[0]).toEqual({ notes: 'n', suggested_vat_code: 'standard' });
  });

  it('rejects a provider transaction id without a connection', async () => {
    await expect(pool.query(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,provider_transaction_id)
       VALUES($1,$2,'2026-09-01',-5,'orphan provider id','only-provider-id')`, [company, bank],
    )).rejects.toThrow(/bank_tx_feed_identity_paired/);
  });

  it('allows a source-field rewrite on an unprocessed posted feed row', async () => {
    const id = await feedRow('posted', `u-${crypto.randomUUID()}`);
    await pool.query('UPDATE bank_transactions SET amount=-50 WHERE id=$1', [id]);
    const { rows } = await pool.query('SELECT amount FROM bank_transactions WHERE id=$1', [id]);
    expect(Number(rows[0].amount)).toBe(-50);
  });

  it('refuses an accounting-column change on a removed row', async () => {
    const id = await feedRow('removed', `r-${crypto.randomUUID()}`);
    await expect(pool.query("UPDATE bank_transactions SET status='matched' WHERE id=$1", [id]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('refuses a source-field rewrite once matched_journal_line_id is set', async () => {
    const id = await feedRow('posted', `m-${crypto.randomUUID()}`);
    await pool.query('UPDATE bank_transactions SET matched_journal_line_id=$1 WHERE id=$2', [journalLine, id]);
    await expect(pool.query('UPDATE bank_transactions SET amount=-999 WHERE id=$1', [id]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('refuses a source-field rewrite once provisional_je_id is set', async () => {
    const id = await feedRow('posted', `v-${crypto.randomUUID()}`);
    await pool.query('UPDATE bank_transactions SET provisional_je_id=$1 WHERE id=$2', [journalEntry, id]);
    await expect(pool.query('UPDATE bank_transactions SET amount=-999 WHERE id=$1', [id]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('allows pending -> posted and pending -> removed, and nothing else', async () => {
    const a = await feedRow('pending', `t-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET feed_state='posted' WHERE id=$1", [a]);
    await expect(pool.query("UPDATE bank_transactions SET feed_state='removed' WHERE id=$1", [a]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
    const b = await feedRow('pending', `t-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET feed_state='removed' WHERE id=$1", [b]);
    await expect(pool.query("UPDATE bank_transactions SET feed_state='posted' WHERE id=$1", [b]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('refuses a source-field rewrite on a processed feed row', async () => {
    const id = await feedRow('posted', `x-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET status='excluded' WHERE id=$1", [id]);
    await expect(pool.query('UPDATE bank_transactions SET amount=-999 WHERE id=$1', [id]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('allows one open conflict per provider transaction', async () => {
    const id = await feedRow('posted', 'c-1');
    const insert = () => pool.query(
      `INSERT INTO bank_feed_transaction_conflicts(company_id,connection_id,bank_transaction_id,
         provider_transaction_id,reason,proposed) VALUES($1,$2,$3,'c-1','processed_row_changed','{}')`,
      [company, conn, id]);
    await insert();
    await expect(insert()).rejects.toThrow(/uq_bank_feed_conflict_open/);
  });

  it('deleting a bank row with a conflict succeeds and cascades to the conflict', async () => {
    const id = await feedRow('posted', 'del-1');
    await pool.query(
      `INSERT INTO bank_feed_transaction_conflicts(company_id,connection_id,bank_transaction_id,
         provider_transaction_id,reason,proposed) VALUES($1,$2,$3,'del-1','processed_row_changed','{}')`,
      [company, conn, id]);
    await pool.query('DELETE FROM bank_transactions WHERE id=$1', [id]);
    const { rows } = await pool.query(
      'SELECT 1 FROM bank_feed_transaction_conflicts WHERE bank_transaction_id=$1', [id]);
    expect(rows).toHaveLength(0);
  });
});
