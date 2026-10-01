/**
 * K-014 — RED. `postSupplierInvoiceToGL` reads the invoice with a plain SELECT
 * (`getSupplierInvoiceById`, line 201 on ebeac9ca) and decides on
 * `invoice.glJournalEntryId` (line 211) WITHOUT taking a row lock.
 *
 * `approveSupplierInvoice` in the same file takes `lockSupplierInvoiceForUpdate`
 * before its read for exactly this reason. The backfill path never did, and it
 * is the one the "Post to GL" bulk action calls
 * (pages/api/accounting/supplier-invoices-bulk-action.ts:87), one request
 * transaction held open across up to 100 bills.
 *
 * The interleave below is SEQUENCED, not raced: two clients, both transactions
 * open, the second call issued only after the first has posted and before it
 * commits. Under READ COMMITTED the second read cannot see the first's write,
 * and with no `FOR UPDATE` it does not block on it either — so both post.
 *
 * Expected on a fixed build: ONE journal for the bill. On ebeac9ca: two, the
 * payable credited twice, and `gl_journal_entry_id` holding only the second —
 * the first is orphaned where `cancelSupplierInvoiceInner`, which reverses only
 * the id on the row, can never reach it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K014-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let expenseAccount: string;

async function openTx(): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  return c;
}

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

async function makeInvoice(number: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_invoices
      (company_id, supplier_id, invoice_number, invoice_date, subtotal,
       tax_rate, tax_amount, total_amount, status, created_by)
    VALUES
      (${COMPANY}::UUID, ${supplier}::UUID, ${number}, '2026-06-30', 100,
       15, 15, 115, 'approved', ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  const id = rows[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items
      (supplier_invoice_id, description, quantity, unit_price, tax_rate,
       tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'K014 line', 1, 100, 15, 15, 100, ${expenseAccount}::UUID)`;
  return id;
}

describeIfDb('K-014 postSupplierInvoiceToGL check-then-act without a row lock', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'K014 ' + TAG}, ${TAG}, NOW())`;
    supplier = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES (${'K014 ' + TAG}, ${COMPANY}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    const acct = async (code: string, name: string, type: string, subtype: string, normal: string) => {
      const rows = (await sql`
        INSERT INTO gl_accounts
          (company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account)
        VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)
        RETURNING id`) as { id: string }[];
      return rows[0]!.id;
    };
    expenseAccount = await acct('6000', 'K014 Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'K014 AP', 'liability', 'payable', 'credit');
    await acct('2200', 'K014 VAT Input', 'asset', 'vat_input', 'debit');
  });

  afterAll(async () => {
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  it('posts ONE journal when two overlapping backfills hit the same bill', async () => {
    const number = `${TAG}-A`;

    const setup = await openTx();
    const id = await run(setup, () => makeInvoice(number));
    await setup.query('COMMIT');
    setup.release();

    // Two request transactions, both open — the two overlapping bulk
    // "Post to GL" requests. Nothing here is timing-dependent: the second call
    // is issued only after the first has posted, and the first commits only
    // after the second is provably waiting inside the database.
    const c1 = await openTx();
    const c2 = await openTx();
    const c2Pid = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    let second: { journalEntryId: string; alreadyPosted: boolean } | undefined;
    try {
      const first = await run(c1, () => postSupplierInvoiceToGL(COMPANY, id, USER));
      expect(first.alreadyPosted).toBe(false);

      // c1 has NOT committed. c2 reads the invoice and finds
      // gl_journal_entry_id still NULL; with no FOR UPDATE it does not block on
      // the invoice row, only later on the GL balance row c1 is holding.
      const p2 = run(c2, () => postSupplierInvoiceToGL(COMPANY, id, USER));

      // Wait for c2 to be blocked on a lock — proof it got past the guard and
      // is already posting — before releasing c1. Bounded WELL under the
      // helper's 5s lock_timeout: at the timeout the wait we are watching for
      // would end in a SupplierInvoiceLockTimeoutError instead, and a genuine
      // pass would read as a failure.
      const probe = await pool.connect();
      let blocked = false;
      for (let i = 0; i < 80 && !blocked; i++) {
        const r = await probe.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE pid = $1 AND wait_event_type = 'Lock'`, [c2Pid],
        );
        blocked = r.rowCount === 1;
        if (!blocked) await new Promise((r2) => setTimeout(r2, 25));
      }
      probe.release();
      expect(blocked).toBe(true);

      await c1.query('COMMIT');
      second = await p2;
      await c2.query('COMMIT');
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      c1.release();
      c2.release();
    }

    const journals = (await sql`
      SELECT count(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${COMPANY}::UUID
        AND description = ${`Supplier invoice ${number}`}`) as { n: number }[];
    // THE CLAIM: one bill, one journal.
    expect(journals[0]!.n).toBe(1);
    expect(second!.alreadyPosted).toBe(true);

    // And the payable is credited once — 115.00, not 230.00.
    const ap = (await sql`
      SELECT COALESCE(SUM(jl.credit), 0)::float8 AS credited
      FROM gl_journal_lines jl
      JOIN gl_accounts a ON a.id = jl.gl_account_id
      WHERE jl.company_id = ${COMPANY}::UUID AND a.account_code = '2100'`) as { credited: number }[];
    expect(ap[0]!.credited).toBeCloseTo(115, 2);

    // The one journal that did post is balanced and agrees with the bill.
    const bal = (await sql`
      SELECT COALESCE(SUM(jl.debit), 0)::float8 AS dr,
             COALESCE(SUM(jl.credit), 0)::float8 AS cr
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${COMPANY}::UUID
        AND je.description = ${`Supplier invoice ${number}`}`) as { dr: number; cr: number }[];
    expect(bal[0]!.dr).toBeCloseTo(115, 2);
    expect(bal[0]!.cr).toBeCloseTo(115, 2);
  }, 60000);

  // Adjacent case — retry. The lock must not turn an idempotent second call
  // into a second journal: a sequential re-post returns the SAME journal id.
  it('is idempotent on a sequential retry', async () => {
    const number = `${TAG}-B`;

    const setup = await openTx();
    const id = await run(setup, () => makeInvoice(number));
    await setup.query('COMMIT');
    setup.release();

    const c1 = await openTx();
    const first = await run(c1, () => postSupplierInvoiceToGL(COMPANY, id, USER));
    await c1.query('COMMIT');
    c1.release();

    const c2 = await openTx();
    const again = await run(c2, () => postSupplierInvoiceToGL(COMPANY, id, USER));
    await c2.query('COMMIT');
    c2.release();

    expect(first.alreadyPosted).toBe(false);
    expect(again.alreadyPosted).toBe(true);
    expect(again.journalEntryId).toBe(first.journalEntryId);

    const journals = (await sql`
      SELECT count(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${COMPANY}::UUID
        AND description = ${`Supplier invoice ${number}`}`) as { n: number }[];
    expect(journals[0]!.n).toBe(1);
  }, 60000);

  // Adjacent case — wrong tenant. The lock is the first statement now, so it is
  // also the first tenant check: another company's id must find nothing and
  // post nothing, not fall through to a read that would.
  it('refuses a bill belonging to another company and posts nothing', async () => {
    const number = `${TAG}-C`;

    const setup = await openTx();
    const id = await run(setup, () => makeInvoice(number));
    await setup.query('COMMIT');
    setup.release();

    const otherCompany = randomUUID();
    const c = await openTx();
    await expect(
      run(c, () => postSupplierInvoiceToGL(otherCompany, id, USER)),
    ).rejects.toThrow(/not found/);
    await c.query('ROLLBACK');
    c.release();

    const journals = (await sql`
      SELECT count(*)::int AS n FROM gl_journal_entries
      WHERE description = ${`Supplier invoice ${number}`}`) as { n: number }[];
    expect(journals[0]!.n).toBe(0);
    const row = (await sql`
      SELECT gl_journal_entry_id FROM supplier_invoices
      WHERE id = ${id}::UUID AND company_id = ${COMPANY}::UUID`) as { gl_journal_entry_id: string | null }[];
    expect(row[0]!.gl_journal_entry_id).toBeNull();
  }, 60000);

  // Adjacent case — the cancelled guard must still run AFTER the lock, in the
  // order it did before: a cancelled bill is refused, not re-posted.
  it('still refuses a cancelled bill once the lock is taken first', async () => {
    const number = `${TAG}-D`;

    const setup = await openTx();
    const id = await run(setup, () => makeInvoice(number));
    await setup.query('COMMIT');
    setup.release();
    await sql`UPDATE supplier_invoices SET status = 'cancelled'
      WHERE id = ${id}::UUID AND company_id = ${COMPANY}::UUID`;

    const c = await openTx();
    await expect(
      run(c, () => postSupplierInvoiceToGL(COMPANY, id, USER)),
    ).rejects.toThrow(/cancelled/);
    await c.query('ROLLBACK');
    c.release();

    const journals = (await sql`
      SELECT count(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${COMPANY}::UUID
        AND description = ${`Supplier invoice ${number}`}`) as { n: number }[];
    expect(journals[0]!.n).toBe(0);
  }, 60000);
});
