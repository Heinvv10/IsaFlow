/**
 * K-061 lock order. A merge re-parents every bank line, receipt and invoice of
 * the source, so it contends with any settlement running for that customer.
 * Settlement paths lock each set ORDER BY id (bank/.claude.md). A merge that
 * took the same rows in heap order would hold the higher id while waiting on
 * the lower one — and a settlement holding the lower id and then asking for
 * the higher one deadlocks against it (40P01 → one side 500s).
 *
 * Each case stores the higher id FIRST in the heap, so an unordered UPDATE
 * reaches it first. A "settlement" connection locks the lower id, waits until
 * the merge is blocked, then locks the higher id. Both must succeed.
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

beforeAll(h.setUp);
afterAll(h.tearDown);
beforeEach(async () => {
  await h.wipe();
  source = await h.customer(h.companyA, 'K061 Lock Source');
  target = await h.customer(h.companyA, 'K061 Lock Target');
});

/** Two UUIDs, [low, high] by Postgres uuid ordering. */
function pair(): [string, string] {
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  return a < b ? [a, b] : [b, a];
}

async function bankId(): Promise<string> {
  const { rows } = await pool.query("SELECT id FROM gl_accounts WHERE company_id=$1 AND account_code='K061-BANK'", [h.companyA]);
  return rows[0].id;
}

const seeders: Record<string, (id: string, n: string) => Promise<unknown>> = {
  bank_transactions: async (id) => pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,suggested_client_id)
     VALUES($1,$2,$3,'2026-06-05',10,$4)`, [id, h.companyA, await bankId(), source]),
  customer_payments: async (id) => pool.query(
    `INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
     VALUES($1,$2,$3,'2026-06-03',10,'eft','confirmed',$4)`, [id, h.companyA, source, h.admin]),
  customer_invoices: async (id, n) => pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,subtotal,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,'2026-06-01',10,10,'approved',$5)`, [id, h.companyA, `K061-L-${n}`, source, h.admin]),
};

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

for (const table of Object.keys(seeders)) {
  it(`${table}: a settlement locking ORDER BY id does not deadlock against a merge`, async () => {
    const [low, high] = pair();
    await seeders[table]!(high, 'high'); // heap order: high first
    await seeders[table]!(low, 'low');

    const settlement: PoolClient = await pool.connect();
    let settled = false;
    try {
      await settlement.query('BEGIN');
      await settlement.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [low]);
      const merging = h.merge({ source_id: source, target_id: target });
      await waitUntilMergeBlocked(table);
      await settlement.query("SET LOCAL lock_timeout = '10s'");
      await settlement.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [high]);
      await settlement.query('COMMIT');
      settled = true;
      const merged = await merging;
      expect(merged.state.statusCode).toBe(200);
    } finally {
      if (!settled) await settlement.query('ROLLBACK').catch(() => undefined);
      settlement.release();
    }
    expect(settled).toBe(true);
  });
}

/**
 * The bank allocator's own lock sequence for a customer receipt
 * (bankAllocationService.allocateTransaction): lockBankTransactionForUpdate on
 * the line, then INSERT INTO customer_payments naming the customer — whose FK
 * takes FOR KEY SHARE on the customer row. A merge holding the customers FOR
 * UPDATE while it waits for that bank line closes a cycle (40P01). It must
 * hold them FOR NO KEY UPDATE, which the FK's KEY SHARE does not wait on.
 */
it('a bank allocation creating a receipt for the source does not deadlock against a merge', async () => {
  const lineId = crypto.randomUUID();
  await seeders.bank_transactions!(lineId, 'line');
  const allocator: PoolClient = await pool.connect();
  let allocated = false;
  try {
    await allocator.query('BEGIN');
    await allocator.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [lineId]);
    const merging = h.merge({ source_id: source, target_id: target });
    await waitUntilMergeBlocked('bank_transactions');
    await allocator.query("SET LOCAL lock_timeout = '10s'");
    await allocator.query(
      `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
       VALUES($1,$2,'2026-06-05',10,'eft','confirmed',$3)`, [h.companyA, source, h.admin]);
    await allocator.query('COMMIT');
    allocated = true;
    const merged = await merging;
    expect(merged.state.statusCode).toBe(200);
    // The receipt committed before the merge read receipts, so it moved too.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM customer_payments WHERE client_id=$1', [source]);
    expect(rows[0].n).toBe(0);
  } finally {
    if (!allocated) await allocator.query('ROLLBACK').catch(() => undefined);
    allocator.release();
  }
  expect(allocated).toBe(true);
});

/**
 * A customer refund's lock sequence (bankAllocationService → planCustomerRefund
 * → lockContactForRefund): the bank line FOR UPDATE, then the customer FOR
 * UPDATE. A merge that locked the customers before the bank lines would be
 * the inverse order. It takes the settlement rows first, so the refund gets
 * its customer while the merge waits on the line.
 */
it('a customer refund holding a bank line and then locking the customer does not deadlock against a merge', async () => {
  const lineId = crypto.randomUUID();
  await seeders.bank_transactions!(lineId, 'refund');
  const refund: PoolClient = await pool.connect();
  let refunded = false;
  try {
    await refund.query('BEGIN');
    await refund.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [lineId]);
    const merging = h.merge({ source_id: source, target_id: target });
    await waitUntilMergeBlocked('bank_transactions');
    await refund.query("SET LOCAL lock_timeout = '10s'");
    await refund.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [source]);
    await refund.query('COMMIT');
    refunded = true;
    expect((await merging).state.statusCode).toBe(200);
  } finally {
    if (!refunded) await refund.query('ROLLBACK').catch(() => undefined);
    refund.release();
  }
  expect(refunded).toBe(true);
});

/**
 * Why the customers are locked FOR NO KEY UPDATE and not FOR UPDATE. An
 * allocation on a line the merge does NOT lock inserts a receipt for the
 * source (FK KEY SHARE on the customer), then applies it — locking the
 * source's invoices. The merge holds those invoices by the time it reaches the
 * customers. FOR UPDATE would wait on the KEY SHARE: a 40P01 cycle.
 */
it('an allocation on an unrelated line that receipts to the source and then applies it does not deadlock against a merge', async () => {
  const lineId = crypto.randomUUID();
  const invoiceId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount)
     VALUES($1,$2,$3,'2026-06-05',10)`, [lineId, h.companyA, await bankId()]);
  await seeders.customer_invoices!(invoiceId, 'apply');
  const allocator: PoolClient = await pool.connect();
  let allocated = false;
  try {
    await allocator.query('BEGIN');
    await allocator.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [lineId]);
    await allocator.query(
      `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
       VALUES($1,$2,'2026-06-05',10,'eft','confirmed',$3)`, [h.companyA, source, h.admin]);
    let done = false;
    const merging = h.merge({ source_id: source, target_id: target }).finally(() => { done = true; });
    // Either the merge finishes (it never waits on the KEY SHARE), or it is
    // stuck on the customers — then applying the receipt closes the cycle.
    for (let i = 0; i < 200 && !done; i++) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM customers%' AND pid <> pg_backend_pid()`);
      if (rows[0].n > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await allocator.query("SET LOCAL lock_timeout = '10s'");
    await allocator.query('SELECT id FROM customer_invoices WHERE id=$1 FOR UPDATE', [invoiceId]);
    await allocator.query('COMMIT');
    allocated = true;
    expect((await merging).state.statusCode).toBe(200);
  } finally {
    if (!allocated) await allocator.query('ROLLBACK').catch(() => undefined);
    allocator.release();
  }
  expect(allocated).toBe(true);
});

/**
 * A recurring run holds its template, then INSERTs an invoice naming the
 * customer. A merge that meets the template only after moving invoices waits
 * for that run and then strands the invoice it created. The merge locks both
 * recurring stores before any UPDATE, so the run's invoice is moved too.
 */
const recurringStores: Record<string, (id: string) => Promise<unknown>> = {
  recurring_invoices: (id) => pool.query(
    `INSERT INTO recurring_invoices(id,company_id,client_id,template_name,frequency,next_run_date,status,created_by)
     VALUES($1,$2,$3,'K061 lock run','monthly','2026-10-01','active',$4)`, [id, h.companyA, source, h.admin]),
  recurring_transaction_templates: (id) => pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,next_run_date,is_active,created_by)
     VALUES($1,$2,'K061 lock run','customer_invoice',jsonb_build_object('clientId',$3::text),'monthly','2026-10-01',true,$4)`,
    [id, h.companyA, source, h.admin]),
};

for (const store of Object.keys(recurringStores)) {
  it(`${store}: an invoice a running recurring run creates during a merge is moved, not stranded`, async () => {
    const templateId = crypto.randomUUID();
    await recurringStores[store]!(templateId);
    const run: PoolClient = await pool.connect();
    let ran = false;
    try {
      await run.query('BEGIN');
      await run.query(`SELECT id FROM ${store} WHERE id=$1 FOR UPDATE`, [templateId]);
      const merging = h.merge({ source_id: source, target_id: target });
      await waitUntilMergeBlocked(store);
      await run.query(
        `INSERT INTO customer_invoices(company_id,invoice_number,customer_id,invoice_date,subtotal,total_amount,status,created_by)
         VALUES($1,'K061-RUN-1',$2,'2026-10-01',10,10,'approved',$3)`, [h.companyA, source, h.admin]);
      await run.query('COMMIT');
      ran = true;
      expect((await merging).state.statusCode).toBe(200);
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM customer_invoices WHERE $1 IN (customer_id, client_id)', [source]);
      expect(rows[0].n).toBe(0);
    } finally {
      if (!ran) await run.query('ROLLBACK').catch(() => undefined);
      run.release();
    }
    expect(ran).toBe(true);
  });
}
