/**
 * Task 3 (fix round 1, finding 3) — fixture coverage for the transfer-link
 * writers and findMatchingTxs: each candidate SELECT now carries
 * `feed_state = 'posted'`, so a pending row on the counterparty side can no
 * longer be picked as a link/match target.
 *
 * autoLinkImportedBatchTransfers and relinkTransferCounterparts run a single
 * set-based UPDATE per pass: if a pending row were still eligible and got
 * bound into the SAME statement as a posted one, migration 675's trigger
 * would abort the WHOLE statement (a per-row exception aborts the enclosing
 * UPDATE), losing the posted link too — not just skipping the pending row.
 * Two free counterpart lines make that failure mode reachable without
 * depending on row-id tie-break order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  autoLinkImportedBatchTransfers, relinkTransferCounterparts,
} from '@/modules/accounting/services/bank/bankTransferLinkService';
import { findMatchingTxs } from '@/modules/accounting/services/bank/bankRulesMatchingHelpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const conn = crypto.randomUUID();
const AMOUNT = 42.5;
const DAY = '2026-09-02';

let seq = 0;
async function addAccount(): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,$3,'BFPW xfer bank','asset','debit','bank')`,
    [id, company, `BFX${String(seq).padStart(4, '0')}`],
  );
  return id;
}

/** An allocated outgoing transfer on its own bank account, with `legs` free lines on `targetBank`. */
async function seedAllocatedTransfer(targetBank: string, legs: number): Promise<string[]> {
  const sourceBank = await addAccount();
  const je = crypto.randomUUID();
  const srcLine = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by)
     VALUES($1,$2,DATE '${DAY}','BFPW xfer','posted',$3)`, [je, company, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,0,${AMOUNT})`, [srcLine, company, je, sourceBank]);
  const lineIds: string[] = [];
  for (let i = 0; i < legs; i += 1) {
    const leg = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$2,$3,$4,${AMOUNT},0)`, [leg, company, je, targetBank]);
    lineIds.push(leg);
  }
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,transfer_journal_entry_id,allocation_type)
     VALUES($1,$2,$3,DATE '${DAY}',${-AMOUNT},'BFPW xfer out','allocated',$4,$5,'transfer')`,
    [crypto.randomUUID(), company, sourceBank, srcLine, je]);
  return lineIds;
}

/** One posted + one pending 'imported' row on `bankAccountId`, both matching AMOUNT/DAY. */
async function seedCandidatePair(bankAccountId: string, batchId: string | null): Promise<{ postedId: string; pendingId: string }> {
  const ins = (state: string, pid: string | null) => pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,import_batch_id,transaction_date,amount,description,
       status,bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,$3,$4,DATE '${DAY}',${AMOUNT},'BFPW xfer in',
       'imported',$5,$6,$7) RETURNING id`,
    [crypto.randomUUID(), company, bankAccountId, batchId, pid ? conn : null, pid, state]);
  const postedId = String((await ins('posted', null)).rows[0].id);
  const pendingId = String((await ins('pending', `pend-${crypto.randomUUID()}`)).rows[0].id);
  return { postedId, pendingId };
}

async function rowOf(id: string) {
  const { rows } = await pool.query(
    'SELECT status, matched_journal_line_id, feed_state FROM bank_transactions WHERE id=$1', [id]);
  return rows[0] as { status: string; matched_journal_line_id: string | null; feed_state: string };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFPW xfer company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  const connHome = await addAccount();
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, connHome]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query(
      'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('autoLinkImportedBatchTransfers — pending candidate excluded', () => {
  it('links only the posted row; the pending row is untouched', async () => {
    const targetBank = await addAccount();
    await seedAllocatedTransfer(targetBank, 2); // two free lines: enough for both if both were candidates
    const batchId = crypto.randomUUID();
    const { postedId, pendingId } = await seedCandidatePair(targetBank, batchId);

    const { linked, failed } = await autoLinkImportedBatchTransfers(company, batchId);

    expect(failed).toBe(false);
    expect(linked).toBe(1);
    expect((await rowOf(postedId)).status).toBe('allocated');
    const pendingRow = await rowOf(pendingId);
    expect(pendingRow).toEqual({ status: 'imported', matched_journal_line_id: null, feed_state: 'pending' });
  });
});

describe('relinkTransferCounterparts — pending candidate excluded', () => {
  it('links only the posted row; the pending row is untouched', async () => {
    const targetBank = await addAccount();
    await seedAllocatedTransfer(targetBank, 1);
    await seedAllocatedTransfer(targetBank, 1); // a second, independent free line
    const { postedId, pendingId } = await seedCandidatePair(targetBank, null);

    const { linked, failed } = await relinkTransferCounterparts(company, targetBank);

    expect(failed).toBe(false);
    expect(linked).toBe(1);
    expect((await rowOf(postedId)).status).toBe('allocated');
    const pendingRow = await rowOf(pendingId);
    expect(pendingRow).toEqual({ status: 'imported', matched_journal_line_id: null, feed_state: 'pending' });
  });
});

describe('findMatchingTxs — pending candidate excluded', () => {
  it('returns only the posted row for a description match', async () => {
    const bankAccountId = await addAccount();
    const ins = (state: string, pid: string | null) => pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,
         status,bank_feed_connection_id,provider_transaction_id,feed_state)
       VALUES($1,$2,$3,DATE '${DAY}',${-AMOUNT},'BFPW WOOLWORTHS','imported',$4,$5,$6) RETURNING id`,
      [crypto.randomUUID(), company, bankAccountId, pid ? conn : null, pid, state]);
    const postedId = String((await ins('posted', null)).rows[0].id);
    await ins('pending', `pend-${crypto.randomUUID()}`);

    const rows = await findMatchingTxs(company, bankAccountId, 'description', '%WOOLWORTHS%');

    expect(rows.map((r) => String(r.id))).toEqual([postedId]);
  });
});
