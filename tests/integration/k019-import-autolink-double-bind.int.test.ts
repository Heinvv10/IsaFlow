// K-019 (HIGH-1): the import batch auto-link pass carried the same defect as
// relinkTransferCounterparts and ran first, so fixing only the relink left the
// double-bind reachable on the import path. It also LEFT JOINed
// gl_journal_lines, marking a row `allocated` with a NULL journal line, and its
// swallowing catch had no savepoint.
// Source: src/modules/accounting/services/bank/bankTransferLinkService.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getPoolForTests } from '@/lib/neon';
import { autoLinkImportedBatchTransfers } from '@/modules/accounting/services/bank/bankTransferLinkService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const AMOUNT = 5000;
const DAY = '2026-03-10';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: user, companyId, claims: {} }) as unknown as Ctx;

let seq = 0;
async function addAccount(): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$2,$3,'K019 import bank','asset','debit')`,
    [id, company, `K19I${String(seq).padStart(4, '0')}`],
  );
  return id;
}

/**
 * An allocated outgoing transfer on its own bank account, whose journal carries
 * `targetLegs` legs on `targetBank` (0 = the JE never touches this bank).
 */
async function seedAllocatedTransfer(targetBank: string, targetLegs: number): Promise<{ je: string; sourceBank: string; legs: string[] }> {
  const sourceBank = await addAccount();
  const je = crypto.randomUUID();
  const srcLine = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by)
     VALUES($1,$2,DATE '${DAY}','K019 import transfer','posted',$3)`,
    [je, company, user],
  );
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,0,${AMOUNT})`,
    [srcLine, company, je, sourceBank],
  );
  const legs: string[] = [];
  for (let i = 0; i < targetLegs; i += 1) {
    const leg = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$2,$3,$4,${AMOUNT},0)`,
      [leg, company, je, targetBank],
    );
    legs.push(leg);
  }
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,transfer_journal_entry_id,allocation_type,allocated_entity_name)
     VALUES($1,$2,$3,DATE '${DAY}',${-AMOUNT},'K019 import out','allocated',$4,$5,'transfer','K019 target')`,
    [crypto.randomUUID(), company, sourceBank, srcLine, je],
  );
  return { je, sourceBank, legs };
}

async function seedBatch(targetBank: string, rows: number): Promise<string> {
  const batchId = crypto.randomUUID();
  for (let i = 0; i < rows; i += 1) {
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,import_batch_id,transaction_date,amount,description,status)
       VALUES($1,$2,$3,$4,DATE '${DAY}',${AMOUNT},$5,'imported')`,
      [crypto.randomUUID(), company, targetBank, batchId, `K019 batch in ${i}`],
    );
  }
  return batchId;
}

async function rowsOn(bankAccountId: string) {
  const { rows } = await pool.query(
    `SELECT status, matched_journal_line_id, transfer_journal_entry_id
       FROM bank_transactions
      WHERE company_id=$1 AND bank_account_id=$2 ORDER BY description`,
    [company, bankAccountId],
  );
  return rows as Array<{ status: string; matched_journal_line_id: string | null; transfer_journal_entry_id: string | null }>;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K019 import fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query(
      `DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)`,
      [company],
    );
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

describe('K-019 import batch auto-link', () => {
  it('never binds the same journal line to two rows of one batch', async () => {
    const targetBank = await addAccount();
    const t = await seedAllocatedTransfer(targetBank, 1);
    const batchId = await seedBatch(targetBank, 2);

    const { linked, failed } = await autoLinkImportedBatchTransfers(company, batchId);
    expect(failed).toBe(false);
    expect(linked).toBe(1);

    const rows = await rowsOn(targetBank);
    const claimed = rows.filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].matched_journal_line_id).toBe(t.legs[0]);
    expect(claimed[0].transfer_journal_entry_id).toBe(t.je);
    expect(rows.filter((r) => r.status === 'imported')).toHaveLength(1);
  });

  it('links both rows when two free counterpart lines exist', async () => {
    const targetBank = await addAccount();
    const a = await seedAllocatedTransfer(targetBank, 1);
    const b = await seedAllocatedTransfer(targetBank, 1);
    const batchId = await seedBatch(targetBank, 2);

    const { linked } = await autoLinkImportedBatchTransfers(company, batchId);
    expect(linked).toBe(2);

    const claimed = (await rowsOn(targetBank)).filter((r) => r.matched_journal_line_id !== null);
    expect(new Set(claimed.map((r) => r.matched_journal_line_id)))
      .toEqual(new Set([a.legs[0], b.legs[0]]));
  });

  it('never marks a row allocated without a journal line behind it', async () => {
    // The journal has no leg on the target bank, so it is not the counterpart.
    // The old LEFT JOIN allocated the row with matched_journal_line_id NULL.
    const targetBank = await addAccount();
    await seedAllocatedTransfer(targetBank, 0);
    const batchId = await seedBatch(targetBank, 1);

    const { linked } = await autoLinkImportedBatchTransfers(company, batchId);
    expect(linked).toBe(0);

    const rows = await rowsOn(targetBank);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('imported');
    expect(rows[0].matched_journal_line_id).toBeNull();
  });

  it('skips a counterpart line an earlier allocation already claimed', async () => {
    const targetBank = await addAccount();
    const t = await seedAllocatedTransfer(targetBank, 1);
    const firstBatch = await seedBatch(targetBank, 1);
    expect((await autoLinkImportedBatchTransfers(company, firstBatch)).linked).toBe(1);

    const secondBatch = await seedBatch(targetBank, 1);
    const { linked } = await autoLinkImportedBatchTransfers(company, secondBatch);
    expect(linked).toBe(0);

    const claimed = (await rowsOn(targetBank)).filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].matched_journal_line_id).toBe(t.legs[0]);
  });

  it('a failure inside the pass does not poison the request transaction', async () => {
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const result = await als.run(ctxFor(client, company), () =>
        autoLinkImportedBatchTransfers(company, 'not-a-uuid'),
      );
      expect(result).toEqual({ linked: 0, failed: true });
      const res = await client.query('SELECT 1 AS ok');
      expect(res.rows[0].ok).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
