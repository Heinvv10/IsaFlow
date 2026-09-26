/**
 * K-061 review round 4: the merge FAILS CLOSED on lock contention. A merge
 * touches every row of a customer, so a multi-step settlement can still
 * interleave with it whatever order the merge takes its own locks in — e.g. a
 * bulk allocation (writeBankBulkAllocate) that locks line B1 → the customer's
 * invoices → line B2. The merge bounds its waits (lock_timeout 5s) and answers
 * a 55P03/40P01 as 409 "retry": its savepoint rolled back, so nothing moved.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k061 } from './k061-customer-merge.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = k061(pool);
let source = '';
let target = '';
let invoice = '';

beforeAll(h.setUp);
afterAll(h.tearDown);
beforeEach(async () => {
  await h.wipe();
  source = await h.customer(h.companyA, 'K061 Contended Source');
  target = await h.customer(h.companyA, 'K061 Contended Target');
  ({ inv: invoice } = await h.footprint(h.companyA, source, 'c'));
});

async function bankLine(suggested: string | null): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,suggested_client_id)
     SELECT $1, id, '2026-06-05', 10, $2 FROM gl_accounts WHERE company_id=$1 AND account_code='K061-BANK'
     RETURNING id`, [h.companyA, suggested]);
  return rows[0].id;
}

async function waitUntilMergeBlocked(table: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()`, [`%${table}%`]);
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`merge never blocked on ${table}`);
}

it('a merge that cannot get its rows within the bound answers 409 and moves nothing', async () => {
  const holder: PoolClient = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM customer_invoices WHERE id=$1 FOR UPDATE', [invoice]);
    const before = await h.snapshot();
    const result = await h.merge({ source_id: source, target_id: target });
    expect(result.state.statusCode).toBe(409);
    expect(JSON.stringify(result.state.body)).toMatch(/retry/);
    expect(await h.snapshot()).toBe(before);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  // Once the holder lets go, the identical merge succeeds.
  expect((await h.merge({ source_id: source, target_id: target })).state.statusCode).toBe(200);
}, 30000);

it('a bulk allocation interleaving bank → invoices → bank with a merge never produces a 500', async () => {
  const b1 = await bankLine(null);
  const b2 = await bankLine(source);
  const bulk: PoolClient = await pool.connect();
  let bulkOutcome = 'committed';
  const before = await h.snapshot();
  try {
    await bulk.query('BEGIN');
    await bulk.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [b1]);
    await bulk.query('SELECT id FROM customer_invoices WHERE id=$1 FOR UPDATE', [invoice]);
    const merging = h.merge({ source_id: source, target_id: target });
    await waitUntilMergeBlocked('customer_invoices');
    try {
      await bulk.query("SET LOCAL lock_timeout = '10s'");
      await bulk.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [b2]);
      await bulk.query('COMMIT');
    } catch (err) {
      bulkOutcome = (err as { code?: string }).code ?? 'error';
      await bulk.query('ROLLBACK');
    }
    const merged = await merging;
    // One side may be the deadlock victim; neither may be a 500.
    expect([200, 409]).toContain(merged.state.statusCode);
    if (merged.state.statusCode === 409) {
      expect(bulkOutcome).toBe('committed');
      expect(await h.snapshot()).toBe(before);
    } else {
      expect(bulkOutcome).toBe('40P01');
    }
  } finally {
    bulk.release();
  }
}, 30000);

/**
 * A request inserts a dunning override / custom field for the TARGET while
 * the merge runs (the customers are FOR NO KEY UPDATE, so the FK does not
 * wait). The merge's move then collides on the unique key: 409 retry, nothing
 * moved — not a 500.
 */
const racingInserts: Record<string, { table: string; insert: string; pre?: string }> = {
  dunning: {
    table: 'customer_dunning_overrides',
    insert: 'INSERT INTO customer_dunning_overrides(company_id,customer_id) VALUES($1,$2)',
  },
  'custom field': {
    table: 'entity_udf_values',
    pre: "INSERT INTO entity_udf_values(company_id,entity_type,entity_id,field_number,value) VALUES($1,'customer',$2,2,'source only')",
    insert: "INSERT INTO entity_udf_values(company_id,entity_type,entity_id,field_number,value) VALUES($1,'customer',$2,2,'racing')",
  },
};

for (const [what, race] of Object.entries(racingInserts)) {
  it(`a ${what} inserted for the target during the merge answers 409 and moves nothing`, async () => {
    await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [target]);
    if (race.pre) await pool.query(race.pre, [h.companyA, source]);
    const sourceBefore = await h.references(source);
    const writer: PoolClient = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(race.insert, [h.companyA, target]);
      const merging = h.merge({ source_id: source, target_id: target });
      await waitUntilMergeBlocked(race.table);
      await writer.query('COMMIT');
      const merged = await merging;
      expect(merged.state.statusCode).toBe(409);
      expect(JSON.stringify(merged.state.body)).toMatch(/retry/);
    } finally {
      writer.release();
    }
    expect(await h.references(source)).toEqual(sourceBefore);
  }, 30000);
}
