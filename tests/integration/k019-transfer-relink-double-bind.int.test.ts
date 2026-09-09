// K-019: relinkTransferCounterparts bound one journal line to two bank
// transactions. `best_matches` de-duplicated with DISTINCT ON (bt_new.id),
// which stops one new transaction matching twice, but nothing stopped two
// different imported transactions on the same bank account matching the same
// source allocation and receiving the same target_je_line_id, and nothing
// excluded a journal line a bank transaction had already claimed.
// Source: src/modules/accounting/services/bank/bankTransferLinkService.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getPoolForTests } from '@/lib/neon';
import { relinkTransferCounterparts } from '@/modules/accounting/services/bank/bankTransferLinkService';

type Ctx = Parameters<typeof als.run>[0];

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: user, companyId, claims: {} } as unknown as Ctx;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const bankA = crypto.randomUUID();
const bankB = crypto.randomUUID();
const je = crypto.randomUUID();
const lineA = crypto.randomUUID();
const lineB = crypto.randomUUID();
const srcTx = crypto.randomUUID();
const newTx1 = crypto.randomUUID();
const newTx2 = crypto.randomUUID();

// Second tenant: identical amounts and dates on its own books.
const oBankA = crypto.randomUUID();
const oBankB = crypto.randomUUID();
const oJe = crypto.randomUUID();
const oLineA = crypto.randomUUID();
const oLineB = crypto.randomUUID();
const oSrcTx = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [
    company, 'K019 transfer fixture', other, 'K019 other tenant',
  ]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$3,'K019A','K019 Bank A','asset','debit'),($2,$3,'K019B','K019 Bank B','asset','debit')`,
    [bankA, bankB, company],
  );
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$3,'K019A','K019 Bank A','asset','debit'),($2,$3,'K019B','K019 Bank B','asset','debit')`,
    [oBankA, oBankB, other],
  );
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by)
     VALUES($1,$3,DATE '2026-03-10','K019 transfer A->B','posted',$5),
           ($2,$4,DATE '2026-03-10','K019 other tenant transfer','posted',$5)`,
    [je, oJe, company, other, user],
  );
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$5,$7,$3,0,5000),($2,$5,$7,$4,5000,0),
           ($8,$6,$9,$10,0,5000),($11,$6,$9,$12,5000,0)`,
    [lineA, lineB, bankA, bankB, company, other, je, oLineA, oJe, oBankA, oLineB, oBankB],
  );
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,allocation_type,allocated_entity_name)
     VALUES($1,$3,$5,DATE '2026-03-10',-5000,'K019 transfer out','allocated',$7,'transfer','K019 Bank B'),
           ($2,$4,$6,DATE '2026-03-10',-5000,'K019 other transfer out','allocated',$8,'transfer','K019 Bank B')`,
    [srcTx, oSrcTx, company, other, bankA, oBankA, lineA, oLineA],
  );
  // Two same-day, same-amount incoming rows; only ONE genuine counterpart exists.
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$3,$4,DATE '2026-03-10',5000,'K019 incoming one','imported'),
           ($2,$3,$4,DATE '2026-03-10',5000,'K019 incoming two','imported')`,
    [newTx1, newTx2, company, bankB],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bankA, bankB, oBankA, oBankB]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

async function targetRows() {
  const { rows } = await pool.query(
    `SELECT id, status, matched_journal_line_id, counterparty_account_id
       FROM bank_transactions
      WHERE company_id=$1 AND bank_account_id=$2 ORDER BY description`,
    [company, bankB],
  );
  return rows as Array<{ id: string; status: string; matched_journal_line_id: string | null; counterparty_account_id: string | null }>;
}

describe('K-019 transfer relink double-bind', () => {
  it('never binds the same journal line to two bank transactions', async () => {
    const count = await relinkTransferCounterparts(company, bankB);

    const rows = await targetRows();
    const claimed = rows.filter((r) => r.matched_journal_line_id !== null);
    const distinct = new Set(claimed.map((r) => r.matched_journal_line_id));

    expect(count).toBe(1);
    expect(claimed).toHaveLength(1);
    expect(distinct.size).toBe(claimed.length);
    // The one bound row points at THIS bank's leg of the transfer journal.
    expect(claimed[0].matched_journal_line_id).toBe(lineB);
    expect(claimed[0].status).toBe('allocated');
    expect(claimed[0].counterparty_account_id).toBe(bankA);
    // The runner-up is left untouched and still visible as unallocated.
    const untouched = rows.filter((r) => r.matched_journal_line_id === null);
    expect(untouched).toHaveLength(1);
    expect(untouched[0].status).toBe('imported');
  });

  it('never claims a journal line belonging to another company', async () => {
    const { rows } = await pool.query(
      `SELECT id, matched_journal_line_id FROM bank_transactions
        WHERE company_id=$1 AND matched_journal_line_id = ANY($2::uuid[])`,
      [company, [oLineA, oLineB]],
    );
    expect(rows).toHaveLength(0);
    // And the other tenant's own rows were not written by this company's pass.
    const { rows: theirs } = await pool.query(
      `SELECT status, matched_journal_line_id FROM bank_transactions
        WHERE company_id=$1 AND bank_account_id=$2`,
      [other, oBankB],
    );
    expect(theirs).toHaveLength(0);
  });

  it('is idempotent: a second pass claims nothing already claimed', async () => {
    const before = await targetRows();
    const count = await relinkTransferCounterparts(company, bankB);
    const after = await targetRows();

    expect(count).toBe(0);
    expect(after.map((r) => r.matched_journal_line_id)).toEqual(
      before.map((r) => r.matched_journal_line_id),
    );
    expect(after.filter((r) => r.matched_journal_line_id !== null)).toHaveLength(1);
  });

  it('a failure inside the relink does not poison the request transaction', async () => {
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      // A non-UUID bank account makes the ::UUID cast fail (22P02) inside the
      // service. Without its own savepoint the whole request tx aborts.
      const count = await als.run(ctxFor(client, company), () =>
        relinkTransferCounterparts(company, 'not-a-uuid'),
      );
      expect(count).toBe(0);

      // The transaction is still usable: this would raise 25P02 otherwise.
      const res = await client.query('SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id=$1', [company]);
      expect(res.rows[0].n).toBe(3);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
