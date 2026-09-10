/**
 * K-015 — `importAPInvoices` INSERTed into `supplier_invoices.balance_due`,
 * a column that exists nowhere in the schema; the real column is `balance`,
 * generated as `total_amount - amount_paid`.
 *
 * Two consequences, both covered here:
 *   1. every row raised 42703, was counted as SKIPPED, and the wizard reported
 *      a clean run that imported nothing;
 *   2. the 42703 aborted the surrounding request transaction, so the
 *      `updateSession` at the end of the loop died with 25P02 and
 *      POST /api/accounting/migration/ap-invoices returned 500.
 *
 * The route wraps the service in `withAuth`, which supplies exactly one
 * transaction for the request, so the per-row `try/catch` cannot save it —
 * a caught SQL error still poisons the transaction unless the row runs inside
 * its own savepoint. These tests drive the service inside that same single
 * request transaction.
 *
 * Also covers the findings from the blind review of the first fix: the
 * settlement leg for an already-paid amount (H1), the duplicate guard that
 * `ON CONFLICT DO NOTHING` never provided (H2), a reason on every skip (M3),
 * up-front rejection of amounts that do not add up (M4), and containment of a
 * failure that happens after the INSERT has already succeeded (L1).
 *
 * K-089 is the same defect on the AR side (migrationImportService.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';
import { computeFingerprint } from '@/modules/accounting/services/capture/captureDeduplicationService';
import { updateSession } from '@/modules/accounting/services/core/migrationService';
import { purgeExpiredDeletes } from '@/modules/accounting/services/core/softDeleteService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const OTHER_COMPANY = randomUUID();
/** Has every system account the import needs EXCEPT opening_balance_equity. */
const NO_EQUITY_COMPANY = randomUUID();
/** June 2026 is a CLOSED fiscal period here; August is open. */
const CLOSED_PERIOD_COMPANY = randomUUID();
const TAG = `K015-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
/**
 * A private schema holding a copy of `supplier_invoices` WITHOUT
 * uq_supplier_invoices_supplier_number, so the tests that must see production's
 * shape can see it. beforeAll replays the foreign keys, the triggers and the
 * RLS policy on to the copy, because `INCLUDING ALL` carries none of them.
 *
 * The previous revision did this with `DROP INDEX` inside the test's own
 * transaction. That was proved non-corrupting — DDL is transactional, so the
 * ROLLBACK always restores the index — but it takes ACCESS EXCLUSIVE on
 * `supplier_invoices` for the length of the test, and the fixture database is
 * shared: eighteen other integration files read that table, and every one of
 * them blocked, timing out with a signature that pointed nowhere near here.
 * A per-run schema locks nothing anyone else touches, and `SET LOCAL
 * search_path` is transaction-scoped, so it unwinds with the ROLLBACK.
 */
const NO_INDEX_SCHEMA = `k015_noidx_${TAG.replace(/-/g, '_').toLowerCase()}`;
/**
 * Copies of the five other tables `purgeExpiredDeletes` sweeps, so the purge
 * test can run the whole real function without reading, locking or deleting a
 * single shared row. `supplier_invoices` is NOT here: the purge test reaches
 * that one through NO_INDEX_SCHEMA, where its rows are.
 */
const PURGE_SCHEMA = `${NO_INDEX_SCHEMA}_purge`;

let pool: Pool;
let sessionId: string;
let noEquitySessionId: string;
let closedPeriodSessionId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>, companyId = COMPANY): Promise<T> {
  return als.run({ client: c, userId: USER, companyId, claims: {} } as never, fn);
}

const bill = (over: Partial<Parameters<typeof importAPInvoices>[2][number]> = {}) => ({
  invoiceNumber: `${TAG}-x`,
  supplierName: `ACME ${TAG}`,
  invoiceDate: '2026-06-30',
  dueDate: '2026-07-30',
  subtotal: 100,
  taxAmount: 15,
  totalAmount: 115,
  amountPaid: 0,
  ...over,
});

describeIfDb('K-015 AP migration import writes only real columns', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const company = async (id: string, label: string, reg: string) => {
      await sql`
        INSERT INTO companies (id, name, registration_number, created_at)
        VALUES (${id}::UUID, ${label}, ${reg}, NOW())`;
    };
    await company(COMPANY, `K015 ${TAG}`, TAG);
    await company(OTHER_COMPANY, `K015 other ${TAG}`, `${TAG}-B`);
    await company(NO_EQUITY_COMPANY, `K015 no-equity ${TAG}`, `${TAG}-C`);
    await company(CLOSED_PERIOD_COMPANY, `K015 closed-period ${TAG}`, `${TAG}-D`);

    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${OTHER_COMPANY}::UUID)`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${NO_EQUITY_COMPANY}::UUID)`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${CLOSED_PERIOD_COMPANY}::UUID)`;
    // A second VAT-less supplier in the SAME company: computeFingerprint folds
    // a missing VAT number to the literal 'no-vat', so this one shares a
    // fingerprint with ACME for any identical invoice number and amount.
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'BETA ' + TAG}, ${COMPANY}::UUID)`;

    const acct = async (
      companyId: string, code: string, name: string,
      type: string, subtype: string, normal: string,
    ) => {
      await sql`
        INSERT INTO gl_accounts
          (company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account)
        VALUES (${companyId}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)`;
    };
    for (const c of [COMPANY, NO_EQUITY_COMPANY, CLOSED_PERIOD_COMPANY]) {
      await acct(c, '6000', 'K015 Expense', 'expense', 'default_expense', 'debit');
      await acct(c, '2100', 'K015 AP', 'liability', 'payable', 'credit');
      await acct(c, '2200', 'K015 VAT Input', 'asset', 'vat_input', 'debit');
    }
    // Only COMPANY gets the clearing account the settlement leg needs.
    await acct(COMPANY, '3100', 'K015 Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    await acct(CLOSED_PERIOD_COMPANY, '3100', 'K015 Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${CLOSED_PERIOD_COMPANY}::UUID, 'Jun 2026', 4, 2027, '2026-06-01', '2026-06-30', 'closed'),
             (${CLOSED_PERIOD_COMPANY}::UUID, 'Aug 2026', 6, 2027, '2026-08-01', '2026-08-31', 'open')`;
    clearSystemAccountCache();

    // Production's shape: everything `supplier_invoices` has except the unique
    // index K-107's migration 646 adds, which is on no origin ref and would
    // mask the defect these tests exist for by raising 23505 first.
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql.unsafe(NO_INDEX_SCHEMA)}`;
    await sql`CREATE TABLE ${sql.unsafe(NO_INDEX_SCHEMA)}.supplier_invoices
                (LIKE public.supplier_invoices INCLUDING ALL)`;

    // `INCLUDING ALL` copies columns, defaults, CHECKs, the PK and the indexes.
    // It copies NO row-level security, NO triggers and NO foreign keys, so a
    // copy left as-is lets a future cross-tenant assertion in this file pass
    // vacuously against a table production FORCEs RLS on.
    //
    // RLS and the triggers are replayed below — both lock only the copy.
    //
    // THE FOUR FOREIGN KEYS ARE DELIBERATELY NOT REPLAYED. `ALTER TABLE … ADD
    // CONSTRAINT … FOREIGN KEY` takes SHARE ROW EXCLUSIVE on the REFERENCED
    // table, i.e. on the shared fixture's `companies`, `suppliers`,
    // `gl_journal_entries` and `captured_documents`, and measured here it
    // blocks behind other agents' work on `companies` — the same shared-lock
    // failure that took eighteen integration files down last round. So the copy
    // enforces no referential integrity: an assertion in this file that depends
    // on an FK (a cascade, a 23503 on a bad supplier_id) would pass vacuously
    // and must be written against `public.supplier_invoices` instead.
    // The five OTHER tables `purgeExpiredDeletes` sweeps, in a schema of their
    // own so that only the purge test sees them: putting an empty `suppliers`
    // in front of the import's search_path hides the real one. Empty, and
    // without foreign keys, for the same lock reason as above.
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql.unsafe(PURGE_SCHEMA)}`;
    for (const t of ['customers', 'suppliers', 'items', 'bank_rules', 'customer_invoices']) {
      await sql`CREATE TABLE ${sql.unsafe(PURGE_SCHEMA)}.${sql.unsafe(t)}
                  (LIKE public.${sql.unsafe(t)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`;
    }

    const borrowed = (await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${NO_INDEX_SCHEMA}
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef LIKE '%supplier_id%'
        AND indexdef LIKE '%invoice_number%'
    `) as { indexname: string }[];
    for (const idx of borrowed) {
      await sql`DROP INDEX ${sql.unsafe(NO_INDEX_SCHEMA)}.${sql.unsafe(idx.indexname)}`;
    }

    const trgs = (await sql`
      SELECT tgname, pg_get_triggerdef(oid) AS def
        FROM pg_trigger
       WHERE tgrelid = 'public.supplier_invoices'::REGCLASS AND NOT tgisinternal`
    ) as { tgname: string; def: string }[];
    for (const t of trgs) {
      await sql`${sql.unsafe(t.def.replace(
        ' ON public.supplier_invoices ', ` ON ${NO_INDEX_SCHEMA}.supplier_invoices `,
      ))}`;
    }
    const policies = (await sql`
      SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'supplier_invoices'`
    ) as { policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }[];
    await sql`ALTER TABLE ${sql.unsafe(NO_INDEX_SCHEMA)}.supplier_invoices ENABLE ROW LEVEL SECURITY`;
    await sql`ALTER TABLE ${sql.unsafe(NO_INDEX_SCHEMA)}.supplier_invoices FORCE ROW LEVEL SECURITY`;
    for (const pol of policies) {
      const roles = String(pol.roles).replace(/^\{|\}$/g, '');
      await sql`${sql.unsafe(
        `CREATE POLICY ${pol.policyname} ON ${NO_INDEX_SCHEMA}.supplier_invoices` +
        ` FOR ${pol.cmd} TO ${roles}` +
        (pol.qual ? ` USING (${pol.qual})` : '') +
        (pol.with_check ? ` WITH CHECK (${pol.with_check})` : ''),
      )}`;
    }
    // The copy carries production's RLS, its trigger and every index except the
    // borrowed unique one; assert that rather than leaving it to the comment.
    const shape = (await sql`
      SELECT c.relrowsecurity, c.relforcerowsecurity,
             (SELECT COUNT(*)::INT FROM pg_policies p
               WHERE p.schemaname = ${NO_INDEX_SCHEMA} AND p.tablename = 'supplier_invoices') AS policies,
             (SELECT COUNT(*)::INT FROM pg_trigger t
               WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${NO_INDEX_SCHEMA} AND c.relname = 'supplier_invoices'`
    ) as { relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number; triggers: number }[];
    expect(shape[0]).toMatchObject({
      relrowsecurity: true, relforcerowsecurity: true,
      policies: policies.length, triggers: trgs.length,
    });

    const session = async (companyId: string) => ((await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by, steps_completed, errors)
      VALUES (${companyId}::UUID, 'sage', ${USER}::UUID,
              '{"coa": true, "suppliers": true}'::JSONB,
              '[{"step": "suppliers", "row": 3, "message": "earlier failure"}]'::JSONB)
      RETURNING id`) as { id: string }[])[0]!.id;
    sessionId = await session(COMPANY);
    noEquitySessionId = await session(NO_EQUITY_COMPANY);
    closedPeriodSessionId = await session(CLOSED_PERIOD_COMPANY);
  }, 60000);

  afterAll(async () => {
    // The DROP is in a `finally`: it used to sit behind ~13 DELETEs, so any one
    // of them throwing left `k015_noidx_<tag>` behind in the shared fixture
    // database permanently, one schema per failed run.
    try {
      const companies = [COMPANY, OTHER_COMPANY, NO_EQUITY_COMPANY, CLOSED_PERIOD_COMPANY];
      for (const c of companies) {
        await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
        await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
          SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
        await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
        await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
        await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
        await sql`DELETE FROM migration_sessions WHERE company_id = ${c}::UUID`;
        await sql`DELETE FROM suppliers WHERE company_id = ${c}::UUID`;
        await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
          SELECT id FROM gl_accounts WHERE company_id = ${c}::UUID)`;
        await sql`DELETE FROM gl_accounts WHERE company_id = ${c}::UUID`;
        await sql`DELETE FROM fiscal_periods WHERE company_id = ${c}::UUID`;
      }
      await sql`DELETE FROM companies WHERE id IN (
        ${COMPANY}::UUID, ${OTHER_COMPANY}::UUID, ${NO_EQUITY_COMPANY}::UUID, ${CLOSED_PERIOD_COMPANY}::UUID)`;
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql.unsafe(NO_INDEX_SCHEMA)} CASCADE`;
      await sql`DROP SCHEMA IF EXISTS ${sql.unsafe(PURGE_SCHEMA)} CASCADE`;
      await pool.end();
    }
  }, 60000);

  it('imports the bill, preserves amount_paid, and leaves the control account agreeing with the subledger', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-1`, amountPaid: 40, reference: `SRC-${TAG}` }),
      ], USER));

      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);

      // The transaction must still be usable after the import — updateSession
      // already ran inside it, and the route commits after this point.
      await c.query('SELECT 1');

      const inv = (await c.query(
        `SELECT total_amount, amount_paid, balance, status, reference, gl_journal_entry_id
           FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-1`],
      )).rows;
      expect(inv).toHaveLength(1);
      expect(Number(inv[0].total_amount)).toBe(115);
      expect(Number(inv[0].amount_paid)).toBe(40);
      expect(Number(inv[0].balance)).toBe(75);
      expect(inv[0].status).toBe('partially_paid');
      expect(inv[0].reference).toBe(`SRC-${TAG}`);
      expect(inv[0].gl_journal_entry_id).toBeTruthy();

      // The origination journal balances and agrees with the bill it raised.
      const je = (await c.query(
        `SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
           FROM gl_journal_lines
          WHERE company_id = $1 AND journal_entry_id = $2`,
        [COMPANY, inv[0].gl_journal_entry_id],
      )).rows[0];
      // A take-on entry carries the OUTSTANDING amount only: two lines at 75.
      expect(Number(je.dr)).toBe(75);
      expect(Number(je.cr)).toBe(75);

      // The control account carries the OUTSTANDING balance: the 40 settled
      // before the cutover never enters this ledger at all.
      const payable = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'payable'`,
        [COMPANY],
      )).rows[0];
      expect(Number(payable.net)).toBe(75);
      expect(Number(payable.net)).toBe(Number(inv[0].balance));

      const equity = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'opening_balance_equity'`,
        [COMPANY],
      )).rows[0];
      // AP take-on is DR opening_balance_equity / CR payable, so measured as
      // credit - debit the clearing account sits at -75.
      expect(Number(equity.net)).toBe(-75);

      // Every posted entry balances.
      const unbalanced = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM (
           SELECT journal_entry_id FROM gl_journal_lines WHERE company_id = $1
            GROUP BY journal_entry_id
           HAVING COALESCE(SUM(debit), 0) <> COALESCE(SUM(credit), 0)) d`,
        [COMPANY],
      )).rows[0];
      expect(unbalanced.n).toBe(0);

      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('merges the step flag and supersedes only its own errors, without growing on a re-run', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const badRow = [bill({ invoiceNumber: `${TAG}-flags`, supplierName: 'Nobody Ltd Unmatched 9182736450' })];
      await run(c, () => importAPInvoices(COMPANY, sessionId, badRow, USER));

      const first = (await c.query(
        `SELECT steps_completed, errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(first.steps_completed).toMatchObject({ coa: true, suppliers: true, ap_invoices: true });
      // The earlier step's error survives, and this run's is recorded.
      expect(first.errors.map((e: { step: string }) => e.step)).toEqual(['suppliers', 'ap_invoices']);

      // Re-running the step must replace its own errors, not append them again.
      await run(c, () => importAPInvoices(COMPANY, sessionId, badRow, USER));
      const second = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(second.errors.map((e: { step: string }) => e.step)).toEqual(['suppliers', 'ap_invoices']);

      // And a clean re-run clears what the failed attempt left behind.
      await run(c, () => importAPInvoices(COMPANY, sessionId, [bill({ invoiceNumber: `${TAG}-flags-ok` })], USER));
      const third = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(third.errors.map((e: { step: string }) => e.step)).toEqual(['suppliers']);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('keeps the other steps\' errors when a new error carries no step key', async () => {
    // The supersede filter used a negated IN. An incoming error without a
    // `step` key put a NULL in that list, which made the predicate NULL for
    // every non-matching row and deleted every other step's errors — the exact
    // loss the expression exists to prevent.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await run(c, () => updateSession(sessionId, COMPANY, {
        // No stepsCompleted, and the error has no `step`.
        errors: [{ row: 2, message: 'a caller that omitted the step' } as never],
      }));

      const sess = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      const steps = sess.errors.map((e: { step?: string }) => e.step ?? null);
      expect(steps).toContain('suppliers');
      expect(steps).toContain(null);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a failing row is skipped without poisoning the rest of the run', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-good-1` }),
        // 22007: invalid input syntax for type date — raised by the INSERT.
        bill({ invoiceNumber: `${TAG}-bad`, invoiceDate: 'not-a-date' }),
        bill({ invoiceNumber: `${TAG}-good-2` }),
      ], USER));

      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.row).toBe(1);

      // updateSession already ran on this connection; it must have survived.
      const sess = (await c.query(
        `SELECT ap_invoices_imported FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(Number(sess.ap_invoices_imported)).toBe(2);

      const rows = (await c.query(
        `SELECT invoice_number FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number LIKE $2 ORDER BY invoice_number`,
        [COMPANY, `${TAG}-good-%`],
      )).rows;
      expect(rows.map(r => r.invoice_number)).toEqual([`${TAG}-good-1`, `${TAG}-good-2`]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a failure after the INSERT rolls the whole row back, invoice and journal alike', async () => {
    // June 2026 is a CLOSED period for this company, so postJournalEntry
    // refuses AFTER the invoice row has already been written. Nothing of that
    // row may survive. August is open, so the row after it must still import.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(CLOSED_PERIOD_COMPANY, closedPeriodSessionId, [
        bill({ invoiceNumber: `${TAG}-late-fail`, invoiceDate: '2026-06-30', dueDate: '2026-09-30' }),
        bill({ invoiceNumber: `${TAG}-after`, invoiceDate: '2026-08-31', dueDate: '2026-09-30' }),
      ], USER), CLOSED_PERIOD_COMPANY);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.row).toBe(0);
      expect(result.errors[0]!.message).toContain('closed fiscal period');

      const survivors = (await c.query(
        `SELECT invoice_number FROM supplier_invoices WHERE company_id = $1 ORDER BY invoice_number`,
        [CLOSED_PERIOD_COMPANY],
      )).rows;
      expect(survivors.map(r => r.invoice_number)).toEqual([`${TAG}-after`]);

      const strayJournal = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM gl_journal_entries
          WHERE company_id = $1 AND description LIKE $2`,
        [CLOSED_PERIOD_COMPANY, `%${TAG}-late-fail%`],
      )).rows[0];
      expect(strayJournal.n).toBe(0);
      await c.query('SELECT 1');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('fails the whole step once, before writing anything, when the clearing account is missing', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await expect(run(c, () => importAPInvoices(NO_EQUITY_COMPANY, noEquitySessionId, [
        bill({ invoiceNumber: `${TAG}-noeq-1`, amountPaid: 40 }),
        bill({ invoiceNumber: `${TAG}-noeq-2`, amountPaid: 40 }),
      ], USER), NO_EQUITY_COMPANY)).rejects.toThrow(/opening_balance_equity/);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = $1`,
        [NO_EQUITY_COMPANY],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('refuses the step for a company with no clearing account, even for unpaid rows', async () => {
    // Under take-on posting EVERY outstanding document needs the clearing
    // account, not only the part-paid ones, so the step is refused up front
    // rather than failing per row.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await expect(run(c, () => importAPInvoices(NO_EQUITY_COMPANY, noEquitySessionId, [
        bill({ invoiceNumber: `${TAG}-noeq-unpaid`, amountPaid: 0 }),
      ], USER), NO_EQUITY_COMPANY)).rejects.toThrow(/opening_balance_equity/);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = $1`,
        [NO_EQUITY_COMPANY],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('imports for two VAT-less suppliers whose rows share a fingerprint', async () => {
    // duplicate_fingerprint is lower(vat|invoice_number|total) with 'no-vat',
    // 'no-inv' and '0' substituted for missing parts, so rows missing the same
    // parts collapse onto one string. Production holds groups of 55-79 live
    // invoices sharing a fingerprint, which is why the column carries no unique
    // index and the wizard's idempotency is a lookup scoped by supplier.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-shared`, supplierName: `ACME ${TAG}` }),
        bill({ invoiceNumber: `${TAG}-shared`, supplierName: `BETA ${TAG}` }),
      ], USER));

      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(2);

      const rows = (await c.query(
        `SELECT DISTINCT duplicate_fingerprint FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-shared`],
      )).rows;
      // One fingerprint, two invoices, two suppliers — and both imported.
      expect(rows).toHaveLength(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a fingerprint shared by many rows of one supplier is not blocked by an index', async () => {
    // The shape the production probe found: rows with no invoice number and a
    // zero total all carry 'no-vat|no-inv|0'. A unique index would have made
    // these unwritable; the wizard's duplicate reporting has to live with it.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const supplierId = (await c.query(
        `SELECT id FROM suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;

      for (let n = 0; n < 3; n++) {
        await c.query(
          `INSERT INTO supplier_invoices
             (company_id, supplier_id, invoice_number, invoice_date, due_date,
              subtotal, tax_amount, total_amount, status, created_by, duplicate_fingerprint)
           VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', 0, 0, 0, 'approved', $4, 'no-vat|no-inv|0')`,
          [COMPANY, supplierId, `${TAG}-degenerate-${n}`, USER],
        );
      }

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND duplicate_fingerprint = 'no-vat|no-inv|0'`,
        [COMPANY],
      )).rows[0];
      expect(rows.n).toBe(3);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('re-running the same file does not import the bill a second time', async () => {
    // Idempotency now comes from the lookup before the INSERT, not from a
    // unique constraint — production data forbids one on this column.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const first = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-rerun` }),
      ], USER));
      expect(first.imported).toBe(1);

      const second = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-rerun` }),
      ], USER));
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]!.field).toBe('invoiceNumber');
      expect(second.errors[0]!.message).toContain(`${TAG}-rerun`);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-rerun`],
      )).rows[0];
      expect(rows.n).toBe(1);

      const journals = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM gl_journal_entries
          WHERE company_id = $1 AND description LIKE $2`,
        [COMPANY, `%${TAG}-rerun%`],
      )).rows[0];
      expect(journals.n).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a re-run with a corrected total does not post the same bill twice', async () => {
    // The operator loop this exists for: import, notice a wrong total, fix the
    // CSV, re-run. The old key was the fingerprint, which carries the total, so
    // the corrected row missed the lookup and minted a SECOND bill and a SECOND
    // take-on journal against the AP control account.
    //
    // The fixture DB carries uq_supplier_invoices_supplier_number — K-107's
    // migration 646, on no origin ref and NOT in production — which would raise
    // 23505 and mask the defect entirely. The transaction's search_path points
    // at a copy of the table without it, so this runs against production's
    // shape without touching the index every other test file depends on.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);
      // Prove the table this test writes to really is the one production has:
      // no unique index on (company_id, supplier_id, invoice_number).
      const borrowed = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM pg_indexes
          WHERE schemaname = $1 AND indexdef ILIKE '%UNIQUE%'
            AND indexdef LIKE '%supplier_id%' AND indexdef LIKE '%invoice_number%'`,
        [NO_INDEX_SCHEMA],
      )).rows[0];
      expect(borrowed.n).toBe(0);

      const first = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-corrected`, subtotal: 100, taxAmount: 15, totalAmount: 115 }),
      ], USER));
      expect(first.imported).toBe(1);

      // Same supplier, same invoice number, corrected total.
      const second = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-corrected`, subtotal: 110, taxAmount: 16.5, totalAmount: 126.5 }),
      ], USER));
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]!.field).toBe('invoiceNumber');
      expect(second.errors[0]!.message).toContain(`${TAG}-corrected`);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2 AND deleted_at IS NULL`,
        [COMPANY, `${TAG}-corrected`],
      )).rows[0];
      expect(rows.n).toBe(1);

      // And the control account carries the one bill's outstanding balance only.
      const payable = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'payable'
            AND l.journal_entry_id IN (
              SELECT id FROM gl_journal_entries
               WHERE company_id = $1 AND description LIKE $2)`,
        [COMPANY, `%${TAG}-corrected%`],
      )).rows[0];
      expect(Number(payable.net)).toBe(115);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('without the borrowed index, a blank-numbered bill still de-duplicates on date, total and reference', async () => {
    // A row with no invoice number has no number to key on, so (supplier,
    // date, total, reference) is the most identity it has — and it has to keep
    // working with the fixture's unique index gone (that index exempts
    // invoice_number = '').
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);

      const first = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: '', subtotal: 200, taxAmount: 30, totalAmount: 230 }),
      ], USER));
      expect(first.imported).toBe(1);

      const second = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: '', subtotal: 200, taxAmount: 30, totalAmount: 230 }),
      ], USER));
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.errors[0]!.message).toContain('Already imported');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = '' AND deleted_at IS NULL`,
        [COMPANY],
      )).rows[0];
      expect(rows.n).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('two DIFFERENT unnumbered bills from one supplier for the same amount both import', async () => {
    // The population the blank number was accepted for: till slips and cash
    // purchases from one supplier that repeat at the same round amount. Keying
    // them on the duplicate fingerprint — lower(vat|invoice_number|total), with
    // no date in it — collapsed them into one, imported the first, and told the
    // operator the rest were "already imported". A take-on that silently loads
    // a fraction of the file is worse than one that refuses.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);

      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: '', invoiceDate: '2026-06-01', dueDate: '2026-06-01', subtotal: 200, taxAmount: 30, totalAmount: 230 }),
        bill({ invoiceNumber: '', invoiceDate: '2026-06-02', dueDate: '2026-06-02', subtotal: 200, taxAmount: 30, totalAmount: 230 }),
        // Same day, same amount, but a different reference — a different slip.
        bill({ invoiceNumber: '', invoiceDate: '2026-06-02', dueDate: '2026-06-02', subtotal: 200, taxAmount: 30, totalAmount: 230, reference: `SLIP-${TAG}` }),
      ], USER));

      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(3);
      expect(result.skipped).toBe(0);

      // And all three are in the payable control account, once each.
      const payable = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'payable'
            AND l.journal_entry_id IN (
              SELECT gl_journal_entry_id FROM supplier_invoices
               WHERE company_id = $1 AND COALESCE(invoice_number, '') = ''
                 AND invoice_date IN (DATE '2026-06-01', DATE '2026-06-02'))`,
        [COMPANY],
      )).rows[0];
      expect(Number(payable.net)).toBe(690);

      // The true duplicate — same supplier, date, total and reference — is
      // still refused, so widening the key did not disarm the guard.
      const again = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: '', invoiceDate: '2026-06-02', dueDate: '2026-06-02', subtotal: 200, taxAmount: 30, totalAmount: 230, reference: `SLIP-${TAG}` }),
      ], USER));
      expect(again.imported).toBe(0);
      expect(again.errors[0]!.message).toContain('2026-06-02');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('the TS and SQL fingerprint producers agree, and migration 670 re-backfills the ones that did not', async () => {
    // computeFingerprint is the only TS producer; migrations 412 and 670 are
    // the SQL one. They disagreed on the amount segment — the column is
    // NUMERIC(15,2), so SQL renders 115 as `115.00` while a JS number renders
    // as `115` — and 412 backfilled EVERY pre-412 row in the SQL format. A
    // lookup from the application could not match any of them, so the duplicate
    // was created again and posted a second time.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const canonical = async (vat: string | null, num: string, amt: number) => (await c.query(
        `SELECT lower(coalesce($1::text, 'no-vat') || '|' || coalesce($2::text, 'no-inv')
                || '|' || coalesce($3::numeric, 0)::NUMERIC(15,2)::TEXT) AS fp`,
        [vat, num, amt],
      )).rows[0].fp as string;

      for (const [vat, num, amt] of [
        [null, '', 115], [null, '', 230], ['4150165685', 'INV-1', 1234.5],
        [null, 'x', 99.99], [null, '', 0], ['ABC', 'A', 1_000_000],
      ] as [string | null, string, number][]) {
        expect(computeFingerprint(vat, num, amt)).toBe(await canonical(vat, num, amt));
      }

      // A row stamped in the OLD TS format — what every post-412 application
      // insert carries — is rewritten by 670's statement into the shared one.
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);
      const supplier = (await c.query(
        `SELECT id FROM public.suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;
      await c.query(
        `INSERT INTO supplier_invoices
           (company_id, supplier_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, status, duplicate_fingerprint, created_by)
         VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', 100, 15, 115, 'approved', 'no-vat|k015-stale|115', $4)`,
        [COMPANY, supplier, `${TAG}-stale`, USER],
      );
      await c.query(readFileSync(
        'scripts/migrations/sql/670_supplier_invoice_fingerprint_canonical_backfill.sql', 'utf8',
      ));
      const after = (await c.query(
        `SELECT duplicate_fingerprint FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-stale`],
      )).rows[0].duplicate_fingerprint as string;
      expect(after).toBe(computeFingerprint(null, `${TAG}-stale`, 115));
      expect(after.endsWith('|115.00')).toBe(true);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('the expiry purge does not hard-delete an invoice whose take-on journal is posted', async () => {
    // Soft-deleting a migrated bill leaves its take-on entry in the GL, which is
    // why the duplicate lookup deliberately ignores `deleted_at`. Five minutes
    // later `purgeExpiredDeletes` used to remove the row outright: the lookup
    // then found nothing, the bill imported again, and the payable control
    // account carried the balance twice for one visible bill — the very outcome
    // the soft-delete case exists to prevent. It also erased the only pointer
    // from the journal back to the document it belongs to.
    //
    // The whole function runs here, against copies of all six tables it sweeps,
    // so nothing shared is read, locked or deleted.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-purge-posted` }),
      ], USER));
      await c.query(
        `UPDATE supplier_invoices SET deleted_at = NOW() - INTERVAL '10 minutes'
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-purge-posted`],
      );
      const supplier = (await c.query(
        `SELECT id FROM public.suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;
      // The comparison case: soft-deleted just as long ago, but no journal.
      await c.query(
        `INSERT INTO supplier_invoices
           (company_id, supplier_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, status, created_by, deleted_at)
         VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', 100, 15, 115, 'approved', $4,
                 NOW() - INTERVAL '10 minutes')`,
        [COMPANY, supplier, `${TAG}-purge-plain`, USER],
      );

      // Now put the five other swept tables' empty copies in front, so the
      // real function's DELETEs over customers, suppliers, items, bank_rules
      // and customer_invoices hit nothing shared. `supplier_invoices` still
      // resolves to the copy holding the two rows above.
      await c.query(`SET LOCAL search_path = ${PURGE_SCHEMA}, ${NO_INDEX_SCHEMA}, public`);
      await run(c, () => purgeExpiredDeletes());
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);

      const left = (await c.query(
        `SELECT invoice_number FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number LIKE $2 ORDER BY invoice_number`,
        [COMPANY, `${TAG}-purge-%`],
      )).rows.map((r: { invoice_number: string }) => r.invoice_number);
      expect(left).toEqual([`${TAG}-purge-posted`]);

      // And the journal it points at is still there, still balanced.
      const je = (await c.query(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net, COUNT(*)::INT AS n
           FROM gl_journal_lines l
          WHERE l.company_id = $1 AND l.journal_entry_id = (
            SELECT gl_journal_entry_id FROM supplier_invoices
             WHERE company_id = $1 AND invoice_number = $2)`,
        [COMPANY, `${TAG}-purge-posted`],
      )).rows[0];
      expect(je.n).toBe(2);
      expect(Number(je.net)).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('the same invoice number for a DIFFERENT supplier is still imported', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-cross`, supplierName: `ACME ${TAG}` }),
        bill({ invoiceNumber: `${TAG}-cross`, supplierName: `BETA ${TAG}` }),
      ], USER));
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(2);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a soft-deleted bill still blocks the re-import, because its take-on entry is still posted', async () => {
    // Soft-deleting a migrated bill does not touch the ledger: softDeleteService
    // only reverses when status = 'posted', and a migrated bill is approved,
    // partially_paid or paid. So the balance is still in the payable control
    // account, and re-importing would carry it twice for one visible bill. An
    // earlier revision scoped the lookup with `deleted_at IS NULL` and blessed
    // exactly that.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);
      await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-softdel` }),
      ], USER));
      await c.query(
        `UPDATE supplier_invoices SET deleted_at = NOW()
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-softdel`],
      );

      const again = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-softdel` }),
      ], USER));
      expect(again.imported).toBe(0);
      expect(again.skipped).toBe(1);
      expect(again.errors[0]!.field).toBe('invoiceNumber');
      expect(again.errors[0]!.message).toContain('still in the ledger');

      // One take-on journal, not two: the payable control carries 115 once.
      const payable = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'payable'
            AND l.journal_entry_id IN (
              SELECT id FROM gl_journal_entries
               WHERE company_id = $1 AND description LIKE $2)`,
        [COMPANY, `%${TAG}-softdel%`],
      )).rows[0];
      expect(Number(payable.net)).toBe(115);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a re-export that changes only the CASE of the invoice number is still the same bill', async () => {
    // computeFingerprint lowercases, so the key this replaced ignored case.
    // Keying on the raw column would have let `inv-1` mint a second bill and a
    // second take-on journal against the payable control.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL search_path = ${NO_INDEX_SCHEMA}, public`);
      const first = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-CASE` }),
      ], USER));
      expect(first.imported).toBe(1);

      const second = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-case`.toLowerCase() }),
      ], USER));
      expect(second.imported).toBe(0);
      expect(second.errors[0]!.field).toBe('invoiceNumber');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND LOWER(invoice_number) = LOWER($2)`,
        [COMPANY, `${TAG}-CASE`],
      )).rows[0];
      expect(rows.n).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('honours the page\'s supplier override, and refuses one from another tenant', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const beta = (await c.query(
        `SELECT id FROM suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `BETA ${TAG}`],
      )).rows[0].id;
      const foreign = (await c.query(
        `SELECT id FROM suppliers WHERE company_id = $1`, [OTHER_COMPANY],
      )).rows[0].id;

      // The name says ACME; the operator corrected it to BETA in the wizard.
      const ok = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        { ...bill({ invoiceNumber: `${TAG}-override` }), supplierId: beta },
      ], USER));
      expect(ok.imported).toBe(1);
      const row = (await c.query(
        `SELECT supplier_id FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-override`],
      )).rows[0];
      expect(row.supplier_id).toBe(beta);

      const bad = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        { ...bill({ invoiceNumber: `${TAG}-override-x` }), supplierId: foreign },
      ], USER));
      expect(bad.imported).toBe(0);
      expect(bad.errors[0]!.field).toBe('supplierId');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('reports a bad row against its position in the operator\'s file, not in the shortened array', async () => {
    // The routes validate row by row and hand the service only the rows that
    // parsed. Reporting row 1 for what was line 3 of the spreadsheet names the
    // wrong line, so the mapping travels with the rows.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-ctx`, supplierName: 'Nobody at all' }),
      ], USER, {
        sourceRows: [7],
        priorErrors: [{ step: 'ap_invoices', row: 2, field: 'invoiceDate', message: 'invoiceDate: Must be a date as YYYY-MM-DD' }],
      }));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
      expect(result.errors.map(e => e.row)).toEqual([2, 7]);

      // And both reached the session, which is the only place the operator sees
      // them after a page reload.
      const sess = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1`, [sessionId],
      )).rows[0];
      const rows = (sess.errors as { step: string; row: number }[])
        .filter(e => e.step === 'ap_invoices').map(e => e.row).sort((a, b) => a - b);
      expect(rows).toEqual([2, 7]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('rejects a row whose amounts are wrong by more than rounding, naming all three', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-round`, subtotal: 33.33, taxAmount: 5, totalAmount: 38.90 }),
      ], USER));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]!.field).toBe('totalAmount');
      expect(result.errors[0]!.message).toContain('33.33');
      expect(result.errors[0]!.message).toContain('5.00');
      expect(result.errors[0]!.message).toContain('38.90');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-round`],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('resolves the supplier within the importing tenant only', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // Both companies own a supplier with the identical name.
      const mine = (await c.query(
        `SELECT id FROM suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;

      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-tenant` }),
      ], USER));
      expect(result.imported).toBe(1);

      const row = (await c.query(
        `SELECT supplier_id FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-tenant`],
      )).rows[0];
      expect(row.supplier_id).toBe(mine);

      const foreign = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = $1`,
        [OTHER_COMPANY],
      )).rows[0];
      expect(foreign.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('skips a row whose supplier does not exist in this tenant', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-missing`, supplierName: 'Nobody Ltd Unmatched 9182736450' }),
      ], USER));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]!.field).toBe('supplierName');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-missing`],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
