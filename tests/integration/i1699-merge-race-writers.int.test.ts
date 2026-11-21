/**
 * #1699 Codex gate at ecc452ea6b, findings 1-4: writers that chose a supplier before a merge committed.
 *   1. a dismissed expected-invoice alert moves with the expectation, so the next gap scan does not raise (and chase) that date again;
 *   2. a gap scan that read the expectation before the merge never lands its alert on the merged-away supplier;
 *   3. the AP take-on import, whose supplier list is read once per batch, finds a bill the merge moved ("Already imported"), and does
 *      not post a second one;
 *   4. the Sage bill import, whose party resolved to a supplier that a merge then soft-deletes, files the bill on the merge's survivor.
 * Each race pauses the REAL merge (mergeEntities in a committed request transaction) behind a row this test holds, starts the writer,
 * waits until both are waiting on a lock, then lets the merge commit. Fixture route: isaflow_schema_fixture (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { detectGaps } from '@/modules/accounting/services/capture/missingInvoiceChaseService';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageMergedWorld } from './helpers/sageMergedSupplierWorld';

assertDisposable();
const w = sageMergedWorld('race-writers');
const { pool, companyId, userId, tag, inRequestTx, insPlain, bill } = w;

const merge = (survivor: string, gone: string) => inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId, 'admin'), true);
const settle = <T>(p: Promise<T>) => p.then((v) => ({ v, e: undefined as unknown }), (e: unknown) => ({ v: undefined as T | undefined, e }));
const TODAY = '2026-06-01';

/** True once `n` sessions other than the holder wait on a lock in this database (the suites run one file at a time per database). */
async function waiting(holderPid: number, n: number): Promise<boolean> {
  for (let i = 0; i < 160; i++) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND pid <> $1", [holderPid]);
    if (rows[0].n >= n) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Holds `sqlText` (a FOR UPDATE of one row) open on its own connection until `release`. */
async function hold(sqlText: string, params: unknown[]) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query(sqlText, params);
  const pid = Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  return { pid, release: async () => { await c.query('ROLLBACK'); c.release(); } };
}

const expectation = async (supplierId: string) => String((await pool.query(
  `INSERT INTO supplier_expectations (company_id, supplier_id, cadence, status, last_invoice_date, expected_day_of_month)
   VALUES ($1, $2, 'monthly', 'locked', '2026-04-05', 5) RETURNING id`, [companyId, supplierId])).rows[0].id);
const alertsOf = async (supplierId: string) => (await pool.query(
  'SELECT id::text AS id, status, expected_by::text AS expected_by FROM expected_invoice_alerts WHERE company_id = $1 AND supplier_id = $2 ORDER BY expected_by',
  [companyId, supplierId])).rows as Array<{ id: string; status: string; expected_by: string }>;

beforeAll(async () => {
  await w.seed();
  await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1, '3999', 'Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit', true, true)`, [companyId]);
  clearSystemAccountCache(companyId);
}, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM migration_sessions WHERE company_id = $1', [companyId]);
  await w.drop();
}, 60000);

describe('expected-invoice alerts and a merge (findings 1 and 2)', () => {
  it('a dismissed alert moves with the expectation: the next gap scan raises no pending alert for that date on the survivor', async () => {
    const gone = await insPlain('Dismissed Gone');
    const survivor = await insPlain('Dismissed Survivor');
    await expectation(gone);
    expect((await detectGaps(companyId, TODAY)).created).toBe(1);
    const [raised] = await alertsOf(gone);
    await pool.query("UPDATE expected_invoice_alerts SET status = 'dismissed', dismissed_reason = 'not a monthly supplier' WHERE id = $1", [raised!.id]);
    await merge(survivor, gone);
    expect(await detectGaps(companyId, TODAY)).toEqual({ created: 0, unchanged: 1 });
    expect(await alertsOf(survivor)).toEqual([{ id: raised!.id, status: 'dismissed', expected_by: raised!.expected_by }]);
    expect(await alertsOf(gone)).toEqual([]);
  });

  it('a gap scan that read the expectation before the merge commits lands no alert on the merged-away supplier', async () => {
    const gone = await insPlain('Gap Race Gone');
    const survivor = await insPlain('Gap Race Survivor');
    await expectation(gone);
    // An open alert of another date, held: the merge locks the open alerts of both suppliers after it holds them FOR UPDATE.
    const parked = String((await pool.query(
      "INSERT INTO expected_invoice_alerts (company_id, supplier_id, expected_by, status) VALUES ($1, $2, '2026-01-05', 'pending') RETURNING id",
      [companyId, gone])).rows[0].id);
    const h = await hold('SELECT id FROM expected_invoice_alerts WHERE id = $1 FOR UPDATE', [parked]);
    let merging: Promise<{ v: unknown; e: unknown }> | undefined;
    let scanning: Promise<{ v: unknown; e: unknown }> | undefined;
    try {
      merging = settle(merge(survivor, gone));
      expect(await waiting(h.pid, 1)).toBe(true);
      // The cron's path (no request): it reads the expectation on the source, then waits for the merge.
      scanning = settle(detectGaps(companyId, TODAY));
      expect(await waiting(h.pid, 2)).toBe(true);
    } finally { await h.release(); }
    expect((await merging!).e).toBeUndefined();
    expect((await scanning!).e).toBeUndefined();
    expect(await alertsOf(gone)).toEqual([]);
    // The parked alert moved with the merge; the next scan raises the gap on the survivor.
    expect((await alertsOf(survivor)).map((a) => a.id)).toEqual([parked]);
    expect((await detectGaps(companyId, TODAY)).created).toBe(1);
    expect((await alertsOf(survivor)).map((a) => a.status)).toEqual(['pending', 'pending']);
  }, 30000);
});

describe('bill importers and a merge (findings 3 and 4)', () => {
  it('AP take-on: a merge committed mid-batch moved the bill; the row is "Already imported", never a second bill', async () => {
    const blocker = await insPlain('TakeOn Blocker');
    const gone = await insPlain('TakeOn Gone');
    const survivor = await insPlain('TakeOn Survivor');
    const session = await inRequestTx(() => createSession(companyId, 'sage', userId));
    const row = (n: string, name: string) => ({
      invoiceNumber: `${n}-${tag}`, supplierName: name, invoiceDate: '2026-04-02', dueDate: '2026-05-02',
      subtotal: 100, taxAmount: 0, totalAmount: 100, amountPaid: 100,
    });
    const first = row('TO-1', 'TakeOn Gone');
    expect((await inRequestTx(() => importAPInvoices(companyId, session.id, [first], userId))).imported).toBe(1);
    // The batch reads its suppliers, then waits on its first row's supplier (held); the merge of the second row's supplier commits.
    const h = await hold('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [blocker]);
    let importing: Promise<{ v: Awaited<ReturnType<typeof importAPInvoices>> | undefined; e: unknown }> | undefined;
    try {
      importing = settle(inRequestTx(() => importAPInvoices(companyId, session.id, [row('TO-B', 'TakeOn Blocker'), first], userId)));
      expect(await waiting(h.pid, 1)).toBe(true);
      await merge(survivor, gone);
    } finally { await h.release(); }
    const out = await importing!;
    expect(out.e).toBeUndefined();
    expect(out.v!.imported).toBe(1);
    expect(out.v!.errors.map((e) => e.message)).toEqual([expect.stringContaining(`Already imported: ${first.invoiceNumber}`)]);
    expect((await pool.query('SELECT supplier_id::text AS s FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, first.invoiceNumber])).rows).toEqual([{ s: survivor }]);
  }, 30000);

  it('Sage bill import: its supplier is merged away while it waits; the bill lands on the survivor', async () => {
    const gone = await insPlain('Bill Race Gone', 'sage', '7301');
    const survivor = await insPlain('Bill Race Survivor');
    await bill('BR-0', 'Bill Race Gone', 7301);
    const parked = String((await pool.query('SELECT id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, `BR-0-${tag}`])).rows[0].id);
    // The merge holds both suppliers FOR UPDATE and stops at its bill UPDATE on the held bill.
    const h = await hold('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [parked]);
    let merging: Promise<{ v: unknown; e: unknown }> | undefined;
    let importing: Promise<{ v: unknown; e: unknown }> | undefined;
    try {
      merging = settle(merge(survivor, gone));
      expect(await waiting(h.pid, 1)).toBe(true);
      // Resolves Sage 7301 to the (still live) supplier, then waits for the merge.
      importing = settle(bill('BR-1', 'Bill Race Gone', 7301));
      expect(await waiting(h.pid, 2)).toBe(true);
    } finally { await h.release(); }
    expect((await merging!).e).toBeUndefined();
    const out = await importing!;
    expect(out.e).toBeUndefined();
    expect(out.v).toMatchObject({ created: true });
    expect((await pool.query('SELECT supplier_id::text AS s FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, `BR-1-${tag}`])).rows).toEqual([{ s: survivor }]);
  }, 30000);
});
