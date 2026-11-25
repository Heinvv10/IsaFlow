/**
 * #1699 breaker races: a REAL supplier merge (mergeEntities, as the duplicates route runs it, role owner) paused while it holds both
 * supplier rows FOR UPDATE, so a writer of the source can be started against it. The pause: a draft bill of the source, held FOR
 * UPDATE by the test, which the merge's bill UPDATE waits on (after its supplier, PO and side locks). Waits are read per backend pid
 * (pg_stat_activity), never by statement text, so another session of the shared fixture database cannot satisfy them.
 */
import type { Pool, PoolClient } from 'pg';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
import { makeBill, openRequest, type BillFixture } from './budgetBillFixture';

export interface Settled<T> { v: T | undefined; e: unknown }
export const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ v, e: undefined }), (e: unknown) => ({ v: undefined, e }));

/** True once backend `pid` waits on a lock (bounded). */
export async function waitsOnLock(pool: Pool, pid: number, ms = 4000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])).rows;
    if (rows.length > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** True once a backend other than `exclude` waits on a lock in this database: a route's own connection (one file runs at a time). */
export async function anotherWaitsOnLock(pool: Pool, exclude: number[], ms = 4000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = (await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND pid <> ALL($1::INT[])", [exclude])).rows;
    if (rows.length > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A row held FOR UPDATE on its own connection until `release`. */
export async function holdRow(pool: Pool, sqlText: string, params: unknown[]): Promise<{ release: () => Promise<void> }> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  await c.query(sqlText, params);
  let done = false;
  return { release: async () => { if (done) return; done = true; try { await c.query('ROLLBACK'); } finally { c.release(); } } };
}

/** A request of `fx.owner` running `fn`, committed when it resolves, rolled back when it throws; `pid` is its backend. */
export async function startRequest<T>(pool: Pool, fx: BillFixture, fn: () => Promise<T>): Promise<{ pid: number; done: Promise<Settled<T>> }> {
  const r = await openRequest(pool, fx, fx.owner);
  const done = settle(r.run(fn).then(async (v) => { await r.commit(); return v; }, async (e) => { await r.rollback(); throw e; }));
  return { pid: r.pid, done };
}

/** The merge of fx.supplier into `target`, paused at its bill UPDATE with both suppliers held FOR UPDATE. */
export async function pausedMerge(pool: Pool, fx: BillFixture, target: string) {
  const parked = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 10 }]);
  const hold = await holdRow(pool, 'SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [parked]);
  const merge = await startRequest(pool, fx, () => mergeEntities(fx.co, 'supplier', target, fx.supplier, fx.owner, autoPostApprovalGuard(true), 'owner'));
  if (!(await waitsOnLock(pool, merge.pid))) { await hold.release(); throw new Error('the merge never reached its bill UPDATE'); }
  return { merge, release: hold.release };
}

/** Rows the fixture's dropBillFixture leaves behind (batches, credit notes, expectations and alerts). */
export async function dropMergeRaceExtras(pool: Pool, fx: BillFixture): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of ['expected_invoice_alerts', 'supplier_expectations', 'credit_notes', 'supplier_payment_batches']) {
      await c.query(`DELETE FROM ${t} WHERE company_id = $1`, [fx.co]);
    }
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
}

/** A posted, imported bank line of `amount` (negative: money out) on a fresh bank GL account, in an open June 2026 period. */
export async function seedBankLine(pool: Pool, fx: BillFixture, amount: number): Promise<string> {
  const bank = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
                    VALUES ($1, $2, $3, 'Bank', 'asset', 'bank', 'debit', 3, true)`, [bank, fx.co, `BB-11${bank.slice(0, 4)}`]);
  await pool.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
                    SELECT $1, 'Jun 2026', 4, 2027, '2026-06-01', '2026-06-30', 'open'
                     WHERE NOT EXISTS (SELECT 1 FROM fiscal_periods WHERE company_id = $1 AND start_date = '2026-06-01')`, [fx.co]);
  return String((await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
                    VALUES ($1, $2, '2026-06-20', $3, 'EFT', 'imported') RETURNING id`, [fx.co, bank, amount])).rows[0].id);
}

/** The cluster's deadlock count (pg_stat_database): a race test asserts it did not move. */
export const deadlocks = async (pool: Pool): Promise<number> =>
  Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);

