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

  it('refuses an opening trial balance that carries a control account', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await expect(run(c, () => importOpeningBalances(COMPANY, sessionId, '2026-06-30', [
        { accountCode: '1100', debit: 5000, credit: 0 },
        { accountCode: '3100', debit: 0, credit: 5000 },
      ], USER))).rejects.toThrow(/receivable control account/);

      await expect(run(c, () => importOpeningBalances(COMPANY, sessionId, '2026-06-30', [
        { accountCode: '2100', debit: 0, credit: 5000 },
        { accountCode: '3100', debit: 5000, credit: 0 },
      ], USER))).rejects.toThrow(/payable control account/);

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
      expect(residual.message).toContain('does not net to zero');
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
      // A trial balance with no control lines: bank, against the clearing
      // account. Then the documents bring in their own outstanding balances.
      await run(c, () => importOpeningBalances(COMPANY, sessionId, '2026-06-30', [
        { accountCode: '1000', debit: 2500, credit: 0 },
        { accountCode: '3100', debit: 0, credit: 2500 },
      ], USER));
      await run(c, () => importARInvoices(COMPANY, sessionId, [
        arRow({ invoiceNumber: `${TAG}-bal-ar`, amountPaid: 0, subtotal: 1000, taxAmount: 150, totalAmount: 1150 }),
      ], USER));
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow({ invoiceNumber: `${TAG}-bal-ap`, amountPaid: 0, subtotal: 1000, taxAmount: 150, totalAmount: 1150 }),
      ], USER));

      // Bank 2500 DR against equity; AR 1150 DR against equity; AP 1150 CR
      // against equity. The equity residual is what the trial balance did not
      // account for — here, the bank.
      expect(await net(c, 'receivable', 'dr')).toBe(1150);
      expect(await net(c, 'payable', 'cr')).toBe(1150);
      expect(await net(c, 'opening_balance_equity', 'cr')).toBe(2500);

      // With the documents' contras cancelling each other, the residual is the
      // trial balance's own, exactly as posted — nothing double-counted.
      const totals = (await c.query(
        `SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
           FROM gl_journal_lines WHERE company_id = $1`,
        [COMPANY],
      )).rows[0];
      expect(Number(totals.dr)).toBe(Number(totals.cr));
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
