// Tenant fence on the transaction views: the shared bank-transaction SELECT's GL join (account name) and the
// bank-query list's join to the line and its GL account. A line pointing at another company's GL account must not
// borrow that account's name, and a query pointing at another company's line must not list it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { listQueries } from '@/modules/accounting/services/capture/bankTxQueryService';
import { bankLine, dropCompanies, seedCompanies, uuid, type FenceCompanies } from './helpers/bankFenceFixture';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
let c: FenceCompanies;
const ids = { own: '', onForeignGl: '', foreignLine: '' };

async function query(company: string, tx: string) {
  await pool.query(
    `INSERT INTO bank_tx_queries(id,company_id,bank_transaction_id,to_number,message_body) VALUES($1,$2,$3,'+27000000000','fence')`,
    [uuid(), company, tx]);
}

describeIfDb('bank tenant fence — transaction views', () => {
  beforeAll(async () => {
    c = await seedCompanies(pool);
    ids.own = await bankLine(pool, c.a, c.bankA, '2025-04-10', 100);
    ids.onForeignGl = await bankLine(pool, c.a, c.bankB, '2025-04-11', 200); // A's line on B's GL account
    ids.foreignLine = await bankLine(pool, c.b, c.bankB, '2025-04-12', 300); // B's own line
    await query(c.a, ids.own);
    await query(c.a, ids.onForeignGl);
    await query(c.a, ids.foreignLine); // A's query pointing at B's line
  });

  afterAll(async () => {
    try {
      await dropCompanies(pool, c);
      await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[c.a, c.b]]);
    } finally {
      await pool.end();
    }
  });

  it("the transaction list shows the GL account name only for this company's own account", async () => {
    const { transactions } = await getBankTransactions(c.a);
    const name = (id: string) => transactions.find((t) => t.id === id)?.bankAccountName;
    expect(transactions.map((t) => t.id).sort()).toEqual([ids.own, ids.onForeignGl].sort());
    expect(name(ids.own)).toBe('Fence A Bank');
    expect(name(ids.onForeignGl)).toBeUndefined();
  });

  it("the query list drops a query that points at another company's line and names no foreign account", async () => {
    const rows = await listQueries(c.a);
    const by = new Map(rows.map((r) => [String(r.bank_transaction_id), r]));
    expect([...by.keys()].sort()).toEqual([ids.own, ids.onForeignGl].sort());
    expect(by.get(ids.own)!.bank_account_name).toBe('Fence A Bank');
    expect(by.get(ids.onForeignGl)!.bank_account_name).toBeNull();
  });
});
