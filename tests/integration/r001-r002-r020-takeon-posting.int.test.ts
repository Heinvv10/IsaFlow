/**
 * R-001 / R-002 / R-020 — take-on posting for the migration wizard.
 *
 * A document the wizard imports was raised, and often partly settled, before the
 * cutover. Only what is still outstanding belongs in this ledger. So the entry
 * is two lines at `total - amountPaid` against opening balance equity, with no
 * revenue, expense or VAT line at all.
 *
 * R-001 was: the full invoice was posted and the paid part settled back out, so
 * the control account sat above the subledger by the paid amount, and — the
 * deciding reason — every take-on document RE-DECLARED its VAT, because
 * getVATReturn reads the GL and sweeps vat_type IS NULL lines into boxes 1
 * and 15. Lines that are never written need no filter.
 *
 * R-002 was: a cent of the exporter's own rounding lost the whole document. A
 * take-on entry carries one figure, so subtotal and tax need not balance against
 * anything.
 *
 * R-020 was: the opening trial balance and the document steps both supplied the
 * AR and AP control totals, doubling them silently.
 *
 * WIZARD PATH ONLY. The Sage commit path posts its own journals and is a
 * separate follow-up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';
import {
  importARInvoices,
  importOpeningBalances,
} from '@/modules/accounting/services/core/migrationImportService';
import { completeSession } from '@/modules/accounting/services/core/migrationService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { arSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R001-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let sessionId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

const arRow = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: `${TAG}-ar`,
  customerName: `ACME ${TAG}`,
  invoiceDate: '2026-06-30',
  dueDate: '2026-07-30',
  subtotal: 1000,
  taxAmount: 150,
  totalAmount: 1150,
  amountPaid: 400,
  ...over,
}) as Parameters<typeof importARInvoices>[2][number];

const apRow = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: `${TAG}-ap`,
  supplierName: `ACME ${TAG}`,
  invoiceDate: '2026-06-30',
  dueDate: '2026-07-30',
  subtotal: 1000,
  taxAmount: 150,
  totalAmount: 1150,
  amountPaid: 400,
  ...over,
}) as Parameters<typeof importAPInvoices>[2][number];

/**
 * A migration session of this test's own, inside the caller's transaction. The
 * shared `sessionId` accumulates committed steps_completed flags from the one
 * test that commits, and the control-total rules read that map.
 */
async function newSession(c: PoolClient): Promise<string> {
  return (await c.query(
    `INSERT INTO migration_sessions (company_id, source_system, started_by)
     VALUES ($1, 'sage', $2) RETURNING id`,
    [COMPANY, USER],
  )).rows[0].id;
}

/** Net movement on a subtype across every posted line in the company. */
async function net(c: PoolClient, subtype: string, dir: 'dr' | 'cr'): Promise<number> {
  const expr = dir === 'dr' ? 'l.debit - l.credit' : 'l.credit - l.debit';
  const rows = (await c.query(
    `SELECT COALESCE(SUM(${expr}), 0) AS n
       FROM gl_journal_lines l
       JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = $1
      WHERE l.company_id = $1 AND a.account_subtype = $2`,
    [COMPANY, subtype],
  )).rows;
  return Number(rows[0].n);
}

describeIfDb('take-on posting for imported documents', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'R001 ' + TAG}, ${TAG}, NOW())`;
    await sql`INSERT INTO customers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)`;

    const acct = async (code: string, name: string, type: string, subtype: string, normal: string) => {
      await sql`
        INSERT INTO gl_accounts
          (company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account)
        VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)`;
    };
    await acct('1100', 'AR', 'asset', 'receivable', 'debit');
    await acct('2100', 'AP', 'liability', 'payable', 'credit');
    await acct('4000', 'Revenue', 'revenue', 'default_revenue', 'credit');
    await acct('6000', 'Expense', 'expense', 'default_expense', 'debit');
    await acct('2120', 'VAT Output', 'liability', 'vat_output', 'credit');
    await acct('2200', 'VAT Input', 'asset', 'vat_input', 'debit');
    await acct('3100', 'Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    await acct('1000', 'Bank', 'asset', 'bank', 'debit');
    await acct('3200', 'Retained Earnings', 'equity', 'retained_earnings', 'credit');
    clearSystemAccountCache();

    sessionId = ((await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by)
      VALUES (${COMPANY}::UUID, 'sage', ${USER}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${COMPANY}::UUID`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM migration_sessions WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  it('posts only the outstanding amount, and no revenue, expense or VAT', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const ar = await run(c, () => importARInvoices(COMPANY, sessionId, [arRow()], USER));
      const ap = await run(c, () => importAPInvoices(COMPANY, sessionId, [apRow()], USER));
      expect(ar.imported).toBe(1);
      expect(ap.imported).toBe(1);
      expect(ar.errors).toEqual([]);
      expect(ap.errors).toEqual([]);

      // 1150 raised, 400 settled before cutover, 750 outstanding.
      expect(await net(c, 'receivable', 'dr')).toBe(750);
      expect(await net(c, 'payable', 'cr')).toBe(750);

      // The whole point: no P&L and no VAT is re-posted.
      for (const subtype of ['default_revenue', 'default_expense', 'vat_output', 'vat_input']) {
        expect([subtype, await net(c, subtype, 'dr')]).toEqual([subtype, 0]);
      }

      // The two contras cancel: AR debits equity, AP credits it.
      expect(await net(c, 'opening_balance_equity', 'cr')).toBe(0);

      // Every entry balances, and each has exactly two lines.
      const shape = (await c.query(
        `SELECT journal_entry_id, COUNT(*)::INT AS lines,
                COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
           FROM gl_journal_lines WHERE company_id = $1 GROUP BY journal_entry_id`,
        [COMPANY],
      )).rows;
      expect(shape).toHaveLength(2);
      for (const e of shape) {
        expect(e.lines).toBe(2);
        expect(Number(e.dr)).toBe(750);
        expect(Number(e.cr)).toBe(750);
      }

      // The documents keep their real figures.
      const inv = (await c.query(
        `SELECT total_amount, amount_paid, balance, status FROM customer_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-ar`],
      )).rows[0];
      expect(Number(inv.total_amount)).toBe(1150);
      expect(Number(inv.amount_paid)).toBe(400);
      expect(Number(inv.balance)).toBe(750);
      expect(inv.status).toBe('partially_paid');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a document settled in full before the cutover posts nothing at all', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const ar = await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-paid`, amountPaid: 1150 }),
      ], USER));
      expect(ar.imported).toBe(1);
      expect(ar.errors).toEqual([]);

      const inv = (await c.query(
        `SELECT amount_paid, balance, status, gl_journal_entry_id FROM customer_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-paid`],
      )).rows[0];
      expect(Number(inv.amount_paid)).toBe(1150);
      expect(Number(inv.balance)).toBe(0);
      expect(inv.status).toBe('paid');
      // No entry to point at: there was nothing to take on.
      expect(inv.gl_journal_entry_id).toBeNull();

      const lines = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM gl_journal_lines WHERE company_id = $1`,
        [COMPANY],
      )).rows[0];
      expect(lines.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('leaves both close-readiness sub-ledger checks passing', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-ar-1` }),
        arRow({ invoiceNumber: `${TAG}-ar-2`, amountPaid: 0 }),
        arRow({ invoiceNumber: `${TAG}-ar-3`, amountPaid: 1150 }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: `${TAG}-ap-1` }),
        apRow({ invoiceNumber: `${TAG}-ap-2`, amountPaid: 0 }),
        apRow({ invoiceNumber: `${TAG}-ap-3`, amountPaid: 1150 }),
      ], USER));

      const period = { endDate: '2026-07-31' };
      const ar = await run(c, () => arSubLedgerCheck(COMPANY, period));
      const ap = await run(c, () => apSubLedgerCheck(COMPANY, period));
      expect([ar.status, ap.status]).toEqual(['pass', 'pass']);

      // The control accounts equal the subledgers: 750 + 1150 outstanding.
      expect(await net(c, 'receivable', 'dr')).toBe(1900);
      expect(await net(c, 'payable', 'cr')).toBe(1900);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('does not move a single VAT201 box', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const before = await run(c, () => getVATReturn(COMPANY, '2026-06-01', '2026-06-30'));

      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-vat-ar` }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: `${TAG}-vat-ap` }),
      ], USER));

      const after = await run(c, () => getVATReturn(COMPANY, '2026-06-01', '2026-06-30'));

      // Every box, every amount, every transaction list, and both totals.
      const boxes = (r: typeof before) => JSON.stringify({
        outputBoxes: r.outputBoxes, inputBoxes: r.inputBoxes,
        totalOutputTax: r.totalOutputTax, totalInputTax: r.totalInputTax,
        netVAT: r.netVAT, outputDetails: r.outputDetails, inputDetails: r.inputDetails,
      });
      expect(boxes(after)).toBe(boxes(before));
      expect(after.outputBoxes.every(b => b.amount === 0 && b.transactions.length === 0)).toBe(true);
      expect(after.inputBoxes.every(b => b.amount === 0 && b.transactions.length === 0)).toBe(true);

      // standardRatedSupplies / standardRatedPurchases DO move, and that is not
      // this change: they are read from customer_invoices and supplier_invoices
      // (subtotal where tax_rate > 0), not from the GL, so any import that
      // creates the document moves them, under any posting shape. Asserted here
      // so the behaviour is recorded rather than discovered.
      expect(after.standardRatedSupplies).toBe(before.standardRatedSupplies + 1000);
      expect(after.standardRatedPurchases).toBe(before.standardRatedPurchases + 1000);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('imports a cent of rounding with a warning and refuses half a rand', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const ok = await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-round-ok`, subtotal: 1000, taxAmount: 150, totalAmount: 1150.01 }),
      ], USER));
      expect(ok.imported).toBe(1);
      expect(ok.errors).toEqual([]);
      expect(ok.warnings).toHaveLength(1);
      expect(ok.warnings![0]!.message).toContain('rounding difference');

      // The warning survives the request: it is on the session, marked, next to
      // the errors, or the operator never sees it after a reload. (A later run
      // of the same step replaces the whole bucket, as it does for errors.)
      const sessErrors = async () => (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0].errors as { message: string; severity?: string }[];
      const persisted = (await sessErrors()).filter(e => e.severity === 'warning');
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.message).toContain('rounding difference');

      const bad = await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-round-bad`, subtotal: 1000, taxAmount: 150, totalAmount: 1150.5 }),
      ], USER));
      expect(bad.imported).toBe(0);
      expect(bad.skipped).toBe(1);
      expect(bad.errors[0]!.message).toContain('1000.00');
      expect(bad.errors[0]!.message).toContain('150.00');
      expect(bad.errors[0]!.message).toContain('1150.50');

      const rows = (await c.query(
        `SELECT invoice_number FROM customer_invoices
          WHERE company_id = $1 AND invoice_number LIKE $2 ORDER BY invoice_number`,
        [COMPANY, `${TAG}-round-%`],
      )).rows;
      expect(rows.map(r => r.invoice_number)).toEqual([`${TAG}-round-ok`]);

    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('serialises two simultaneous imports of the same file into one set of documents', async () => {
    // AP, deliberately. The AR insert names ON CONFLICT (company_id,
    // invoice_number) against uq_customer_invoices_company_number, so a second
    // inserter already blocks on that index — AR was never the race. AP's
    // idempotency is a bare read-then-write on duplicate_fingerprint, which
    // cannot carry a unique index (migration 625, withdrawn). These two
    // transactions overlap deliberately: B starts while A is still open.
    //
    // The fixture also carries uq_supplier_invoices_supplier_number, which is
    // K-107's migration 646 and NOT in production. Where it is present it
    // blocks B's INSERT too — with a 23505 that this row's savepoint reports as
    // a raw Postgres message. So the assertions below are on the OUTCOME the
    // lock alone produces: one document, and a skip explained in the wizard's
    // own words. Without the lock the test goes red either way — two rows
    // where the index is absent, a duplicate-key message where it is present.
    const a = await pool.connect();
    const b = await pool.connect();
    const number = `${TAG}-race`;
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      const resultA = await run(a, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: number, amountPaid: 0 }),
      ], USER));
      expect(resultA.imported).toBe(1);

      // B starts while A is still uncommitted. It must block on the advisory
      // lock rather than read past A and insert a second copy.
      let bSettled = false;
      const rowB = run(b, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: number, amountPaid: 0 }),
      ], USER)).then(r => { bSettled = true; return r; });

      await new Promise(r => setTimeout(r, 250));
      expect(bSettled).toBe(false);

      await a.query('COMMIT');
      const resultB = await rowB;

      // B now sees A's row and skips it — reported by the fingerprint lookup,
      // not by a constraint violation leaking out of the savepoint.
      expect(resultB.imported).toBe(0);
      expect(resultB.skipped).toBe(1);
      expect(resultB.errors).toHaveLength(1);
      expect(resultB.errors[0]!.message).toContain('Already imported');
      expect(resultB.errors[0]!.message).not.toContain('duplicate key');
      await b.query('COMMIT');

      const rows = (await sql`
        SELECT COUNT(*)::INT AS n FROM supplier_invoices
        WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${number}
      `) as { n: number }[];
      expect(rows[0]!.n).toBe(1);

      const entries = (await sql`
        SELECT COUNT(*)::INT AS n FROM gl_journal_entries
        WHERE company_id = ${COMPANY}::UUID AND description LIKE ${'%' + number + '%'}
      `) as { n: number }[];
      expect(entries[0]!.n).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
      // This test commits, so it cleans up after itself.
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL
                 WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${number}`;
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM supplier_invoices
                 WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${number}`;
    }
  }, 60000);

  it('refuses a control account in the trial balance once the documents are in', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const session = await newSession(c);
      // The AR and AP document steps have run: the control totals are already
      // in the ledger one line per document, so the trial balance may not carry
      // them as well.
      await run(c, () => importARInvoices(COMPANY, session, [
        arRow({ invoiceNumber: `${TAG}-r020-ar`, amountPaid: 0 }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, session, [
        apRow({ invoiceNumber: `${TAG}-r020-ap`, amountPaid: 0 }),
      ], USER));

      await expect(run(c, () => importOpeningBalances(COMPANY, session, '2026-06-30', [
        { accountCode: '1100', debit: 5000, credit: 0 },
        { accountCode: '3100', debit: 0, credit: 5000 },
      ], USER))).rejects.toThrow(/receivable control account/);

      await expect(run(c, () => importOpeningBalances(COMPANY, session, '2026-06-30', [
        { accountCode: '2100', debit: 0, credit: 5000 },
        { accountCode: '3100', debit: 5000, credit: 0 },
      ], USER))).rejects.toThrow(/payable control account/);

      // Neither refusal wrote an opening-balance line.
      const lines = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM gl_journal_lines l
           JOIN gl_journal_entries e ON e.id = l.journal_entry_id
          WHERE l.company_id = $1 AND e.description LIKE 'Opening balances%'`,
        [COMPANY],
      )).rows[0];
      expect(lines.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('lets a summary-only migration bring AR and AP in on the trial balance, then blocks the documents', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const session = await newSession(c);
      // No document steps yet. A tenant with no invoice-level detail brings the
      // control totals in on the trial balance — the only route it has.
      const { journalEntryId } = await run(c, () => importOpeningBalances(COMPANY, session, '2026-06-30', [
        { accountCode: '1100', debit: 5000, credit: 0 },
        { accountCode: '2100', debit: 0, credit: 2000 },
        { accountCode: '3100', debit: 0, credit: 3000 },
      ], USER));
      expect(journalEntryId).toBeTruthy();
      expect(await net(c, 'receivable', 'dr')).toBe(5000);
      expect(await net(c, 'payable', 'cr')).toBe(2000);

      // Having taken the control totals, the document steps must refuse: they
      // would post the same money a second time.
      await expect(run(c, () => importARInvoices(COMPANY, session, [
        arRow({ invoiceNumber: `${TAG}-summary-ar` }),
      ], USER))).rejects.toThrow(/already carries an accounts receivable control total/);
      await expect(run(c, () => importAPInvoices(COMPANY, session, [
        apRow({ invoiceNumber: `${TAG}-summary-ap` }),
      ], USER))).rejects.toThrow(/already carries an accounts payable control total/);

      const docs = (await c.query(
        `SELECT (SELECT COUNT(*)::INT FROM customer_invoices WHERE company_id = $1) AS ar,
                (SELECT COUNT(*)::INT FROM supplier_invoices WHERE company_id = $1) AS ap`,
        [COMPANY],
      )).rows[0];
      expect(docs.ar).toBe(0);
      expect(docs.ap).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a document step that imported nothing does not bar the summary-only route', async () => {
    // The step flag is written even by a run where every row was skipped. Gating
    // the trial-balance control total on that flag permanently barred an
    // operator whose first AP file matched no supplier: nothing was taken on,
    // so there is nothing to double count, and the flag can never be cleared.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const session = await newSession(c);
      const failed = await run(c, () => importAPInvoices(COMPANY, session, [
        apRow({ invoiceNumber: `${TAG}-nothing`, supplierName: 'Nobody Ltd Unmatched 5514872' }),
      ], USER));
      expect(failed.imported).toBe(0);
      expect(failed.skipped).toBe(1);

      // The step ran, and is marked as such.
      const flags = (await c.query(
        `SELECT steps_completed, ap_invoices_imported FROM migration_sessions
          WHERE id = $1 AND company_id = $2`,
        [session, COMPANY],
      )).rows[0];
      expect(flags.steps_completed).toMatchObject({ ap_invoices: true });
      expect(Number(flags.ap_invoices_imported)).toBe(0);

      // And the control total is still allowed in, because no document is.
      const { journalEntryId } = await run(c, () => importOpeningBalances(COMPANY, session, '2026-06-30', [
        { accountCode: '2100', debit: 0, credit: 2000 },
        { accountCode: '3100', debit: 2000, credit: 0 },
      ], USER));
      expect(journalEntryId).toBeTruthy();
      expect(await net(c, 'payable', 'cr')).toBe(2000);

      // Having taken it, the AP document step now refuses, as it must.
      await expect(run(c, () => importAPInvoices(COMPANY, session, [
        apRow({ invoiceNumber: `${TAG}-nothing-2` }),
      ], USER))).rejects.toThrow(/accounts payable control total/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('serialises opening balances against a document step running at the same instant', async () => {
    // The R-020 interlock is a read-then-write on the session that BOTH sides
    // perform. importOpeningBalances took no lock, so an overlapping pair — the
    // trial balance carrying an AP control total, and the AP document step —
    // each read a session without the other's mark, both passed their own
    // assertion, and both posted: the double count R-020 exists to prevent.
    const a = await pool.connect();
    const b = await pool.connect();
    let session = '';
    try {
      await a.query('BEGIN');
      session = await newSession(a);
      await a.query('COMMIT');

      await a.query('BEGIN');
      await b.query('BEGIN');

      const ap = await run(a, () => importAPInvoices(COMPANY, session, [
        apRow({ invoiceNumber: `${TAG}-interlock`, amountPaid: 0 }),
      ], USER));
      expect(ap.imported).toBe(1);

      // B opens while A is still uncommitted. It must block on the same lock
      // rather than read a session that does not yet know about A's documents.
      let bSettled = false;
      const openingB = run(b, () => importOpeningBalances(COMPANY, session, '2026-06-30', [
        { accountCode: '2100', debit: 0, credit: 2000 },
        { accountCode: '3100', debit: 2000, credit: 0 },
      ], USER)).then(
        r => { bSettled = true; return { ok: true as const, r }; },
        e => { bSettled = true; return { ok: false as const, e: e as Error }; },
      );

      await new Promise(r => setTimeout(r, 250));
      expect(bSettled).toBe(false);

      await a.query('COMMIT');
      const outcome = await openingB;

      // B now sees A's documents and refuses its control total.
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.e.message).toMatch(/payable control account/);
      await b.query('ROLLBACK');

      // Exactly one posting against the AP control account: the document's.
      const payable = (await sql`
        SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
          FROM gl_journal_lines l
          JOIN gl_accounts a ON a.id = l.gl_account_id
         WHERE l.company_id = ${COMPANY}::UUID AND a.account_subtype = 'payable'
      `) as { net: string }[];
      expect(Number(payable[0]!.net)).toBe(1150);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
      // This test commits, so it cleans up after itself.
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL
                 WHERE company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
      if (session) await sql`DELETE FROM migration_sessions WHERE id = ${session}::UUID AND company_id = ${COMPANY}::UUID`;
    }
  }, 60000);

  it('blocks only the side the trial balance carried', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const session = await newSession(c);
      await run(c, () => importOpeningBalances(COMPANY, session, '2026-06-30', [
        { accountCode: '2100', debit: 0, credit: 2000 },
        { accountCode: '3100', debit: 2000, credit: 0 },
      ], USER));

      await expect(run(c, () => importAPInvoices(COMPANY, session, [
        apRow({ invoiceNumber: `${TAG}-oneside-ap` }),
      ], USER))).rejects.toThrow(/accounts payable control total/);

      // AR was never in the trial balance, so its documents still import.
      const ar = await run(c, () => importARInvoices(COMPANY, session, [
        arRow({ invoiceNumber: `${TAG}-oneside-ar`, amountPaid: 0 }),
      ], USER));
      expect(ar.imported).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('records the clearing residual on the session when the wizard ends out of balance', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // An AR document with nothing to offset it: equity ends 1150 out.
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-resid`, amountPaid: 0 }),
      ], USER));

      await run(c, () => completeSession(sessionId, COMPANY));

      const sess = (await c.query(
        `SELECT status, errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      // Recorded, not enforced: the wizard still completes.
      expect(sess.status).toBe('completed');
      const residual = sess.errors.find((e: { step: string }) => e.step === 'complete');
      expect(residual).toBeTruthy();
      expect(residual.message).toContain('1150.00');
      expect(residual.message).toContain('Opening Balance Equity holds');
      expect(residual.severity).toBe('warning');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('ignores a second, non-system opening-balance-equity account in the residual', async () => {
    // The residual summed every account with subtype opening_balance_equity,
    // while getSystemAccountId resolves the clearing account by subtype AND
    // is_system_account AND is_active. A chart carrying a second, manually
    // created OBE account therefore had lines the take-on never posted to
    // counted into its residual.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const other = (await c.query(
        `INSERT INTO gl_accounts
           (company_id, account_code, account_name, account_type, account_subtype,
            normal_balance, is_active, is_system_account)
         VALUES ($1, '3199', 'Legacy OBE', 'equity', 'opening_balance_equity', 'credit', true, false)
         RETURNING id`,
        [COMPANY],
      )).rows[0].id;

      // AR and AP take-on of the same amount: their contras cancel on the
      // SYSTEM clearing account, so the residual is zero. The legacy account
      // then gets an unrelated posting of its own.
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-legacy-obe-ar`, amountPaid: 0 }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: `${TAG}-legacy-obe-ap`, amountPaid: 0 }),
      ], USER));

      const je = (await c.query(
        `INSERT INTO gl_journal_entries
           (company_id, entry_number, entry_date, description, source, status, created_by)
         VALUES ($1, 'JE-LEGACY-OBE', '2026-06-30', 'Legacy equity move', 'auto_migration', 'posted', $2)
         RETURNING id`,
        [COMPANY, USER],
      )).rows[0].id;
      await c.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
         VALUES ($1, $2, $3, 900, 0, 'legacy')`,
        [COMPANY, je, other],
      );

      await run(c, () => completeSession(sessionId, COMPANY));

      const sess = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      // The 900 on the non-system account is none of the wizard's business.
      expect(sess.errors.some((e: { step: string }) => e.step === 'complete')).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('records nothing when take-on and the trial balance agree', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // AR and AP take-on of the same outstanding amount: the contras cancel.
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-bal2-ar`, amountPaid: 0 }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: `${TAG}-bal2-ap`, amountPaid: 0 }),
      ], USER));

      await run(c, () => completeSession(sessionId, COMPANY));

      const sess = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(sess.errors.some((e: { step: string }) => e.step === 'complete')).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('clears opening balance equity to zero across a consistent trial balance and document set', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // The prescribed procedure: take the source trial balance, REMOVE its AR
      // and AP control lines, and let opening balance equity absorb what that
      // removal leaves — here AR 1150 out, AP 575 in, so 575 debit.
      await run(c, () => importOpeningBalances(COMPANY, sessionId, '2026-06-30', [
        { accountCode: '1000', debit: 2500, credit: 0 },
        { accountCode: '3100', debit: 575, credit: 0 },
        { accountCode: '3200', debit: 0, credit: 3075 },
      ], USER));
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-bal-ar`, amountPaid: 0, subtotal: 1000, taxAmount: 150, totalAmount: 1150 }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: `${TAG}-bal-ap`, amountPaid: 0, subtotal: 500, taxAmount: 75, totalAmount: 575 }),
      ], USER));

      expect(await net(c, 'receivable', 'dr')).toBe(1150);
      expect(await net(c, 'payable', 'cr')).toBe(575);
      // The memo's test 6: the clearing account nets to zero.
      expect(await net(c, 'opening_balance_equity', 'dr')).toBe(0);

      const totals = (await c.query(
        `SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
           FROM gl_journal_lines WHERE company_id = $1`,
        [COMPANY],
      )).rows[0];
      expect(Number(totals.dr)).toBe(Number(totals.cr));

      // And nothing is recorded on the session.
      await run(c, () => completeSession(sessionId, COMPANY));
      const sess = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(sess.errors.some((e: { step: string }) => e.step === 'complete')).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('says the residual is the trial balance plug rather than accusing the operator', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // The other common convention: the whole trial balance balanced ON opening
      // balance equity. The documents' contras cancel, so the residual is the
      // rest of the trial balance and nothing is double-counted.
      await run(c, () => importOpeningBalances(COMPANY, sessionId, '2026-06-30', [
        { accountCode: '1000', debit: 2500, credit: 0 },
        { accountCode: '3100', debit: 0, credit: 2500 },
      ], USER));
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-plug-ar`, amountPaid: 0 }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: `${TAG}-plug-ap`, amountPaid: 0 }),
      ], USER));

      await run(c, () => completeSession(sessionId, COMPANY));
      const sess = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      const residual = sess.errors.find((e: { step: string }) => e.step === 'complete');
      expect(residual).toBeTruthy();
      expect(residual.severity).toBe('warning');
      expect(residual.message).toContain('-2500.00');
      expect(residual.message).toContain('expected if you balanced the opening trial balance');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('does not count an earlier session\'s take-on into a later session\'s residual', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-scope`, amountPaid: 0 }),
      ], USER));

      // Two more sessions over the SAME contras: one that began before they
      // were posted, one that began after.
      const mkSession = async (offset: string): Promise<string> => (await c.query(
        `INSERT INTO migration_sessions (company_id, source_system, started_by, started_at)
         VALUES ($1, 'sage', $2, clock_timestamp() + $3::INTERVAL) RETURNING id`,
        [COMPANY, USER, offset],
      )).rows[0].id;

      const earlier = await mkSession('-1 hour');
      const later = await mkSession('1 second');

      await run(c, () => completeSession(earlier, COMPANY));
      await run(c, () => completeSession(later, COMPANY));

      const errorsFor = async (id: string) => (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [id, COMPANY],
      )).rows[0].errors as { step: string }[];

      // The session that was running when they were posted owns them.
      expect((await errorsFor(earlier)).some(e => e.step === 'complete')).toBe(true);
      // The one that started afterwards does not.
      expect((await errorsFor(later)).some(e => e.step === 'complete')).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
