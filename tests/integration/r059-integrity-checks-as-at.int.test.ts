/**
 * R-059 round 2 (census) — the two integrity checks that report an
 * outstanding balance take it from the ageing AT their `as_at`.
 *
 * `invoices_null_due_date` ("quantifies what the ageing is understating") and
 * `test_records_in_production` ("its balance is in the aging") both read
 * TODAY's amount_paid; the first also dropped status 'paid', the second
 * counted drafts, cancelled and deleted documents. Both are reachable through
 * the MCP `integrity_checks` tool, whose `as_at` defaults to today.
 *
 * A customer and a supplier whose names announce them as test data:
 *   AR  I 1000, no due date, raised −100, paid in full −50 (status 'paid')
 *       D  200, no due date, a draft raised −90
 *   AP  B  400, raised −100, paid in full −50 (status 'paid')
 *       E   80, a draft raised −90
 *
 *   as_at −70: null-due-date 1 invoice / 1000; test records 1000 + 400
 *   as_at today: 0 / 0; test records 0
 * Before the fix: −70 gave 0 / 0 and 200 + 80; today gave 0 and 200 + 80.
 *
 * ROUND 4 adds a NULL-status leg. `status` is nullable on both invoice tables
 * and `NULL NOT IN ('draft','cancelled')` is NULL, not TRUE, so the bare
 * comparison these checks were given in round 2 dropped a null-status document
 * — while the very ageing they claim to quote keeps it. An AR invoice of 700
 * with no due date and a supplier bill of 250, both unpaid and null-status,
 * are counted at BOTH dates, which is what the COALESCE buys.
 *
 * ROUND 7 gives the null-status AR invoice a posted journal that moves the
 * debtor and NO revenue account, for invoicesWithoutRevenueLine — the fourth
 * site of the census, whose <> ALL(...) was NULL for a null-status invoice, so
 * an issued invoice that recognised no revenue went unreported.
 *
 * ROUND 3 (LOW-3) adds the soft-delete leg, which nothing pinned: deleting
 * either `documentInLedgerAsAtFragment` line from testRecordsInProduction left
 * the file green. A soft-deleted AR invoice of 500 and AP bill of 300 are
 * added, each with a posted approval journal and a posted reversal, both dated
 * −95 — an EVEN chain at every as_at here, so the document is out of the
 * ledger and must count nowhere. Without the fragment the subquery has no
 * deleted_at test of any kind, so each amount reappears at BOTH dates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { invoicesNullDueDate, invoicesWithoutRevenueLine } from '@/modules/accounting/services/gl/integrityChecks/documentChecks';
import { testRecordsInProduction } from '@/modules/accounting/services/gl/integrityChecks/vatChecks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R059IC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PAYTAG = `R59I-${Math.floor(Math.random() * 1e9)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const PAST = shift(-70);
const ctx = (asAt: string) => ({ companyId: COMPANY, asAt, limit: 10 });

describeIfDb('R-059 integrity checks read the ageing at their as_at', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059IC ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    const [cu] = (await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'QA Test Customer ' + TAG})
                            RETURNING id`) as { id: string }[];
    const [su] = (await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'Demo Supplier ' + TAG})
                            RETURNING id`) as { id: string }[];

    const [inv] = (await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${cu!.id}::UUID, ${cu!.id}::UUID, ${TAG + '-I'}, ${shift(-100)}::date,
        NULL, 'paid', 1000, 0, 0, 1000, 1000, ${USER}::UUID),
             (${COMPANY}::UUID, ${cu!.id}::UUID, ${cu!.id}::UUID, ${TAG + '-D'}, ${shift(-90)}::date,
        NULL, 'draft', 200, 0, 0, 200, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    const [cp] = (await sql`
      INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + 'C'}, ${cu!.id}::UUID, ${shift(-50)}::date, 1000, 'confirmed', ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${cp!.id}::UUID, ${inv!.id}::UUID, 1000)`;

    const [bill] = (await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${su!.id}::UUID, ${TAG + '-B'}, ${shift(-100)}::date, ${shift(-90)}::date,
        'paid', 400, 0, 400, 400, ${USER}::UUID),
             (${COMPANY}::UUID, ${su!.id}::UUID, ${TAG + '-E'}, ${shift(-90)}::date, ${shift(-80)}::date,
        'draft', 80, 0, 80, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    const [sp] = (await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + 'S'}, ${su!.id}::UUID, ${shift(-50)}::date, 400, 'processed', ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${sp!.id}::UUID, ${bill!.id}::UUID, 400)`;

    // The null-status pair. Not drafts, not cancelled — real debt, and the
    // only thing that kept it out of both checks was NULL-propagation.
    // Its journal debits the debtor and credits a liability: no revenue leg.
    const [debtor] = (await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
      VALUES (${COMPANY}::UUID, '1120', 'Debtors', 'asset', 'debit', 3, true) RETURNING id`) as { id: string }[];
    const [suspense] = (await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
      VALUES (${COMPANY}::UUID, '2999', 'Suspense', 'liability', 'credit', 3, true) RETURNING id`) as { id: string }[];
    const noRevenue = randomUUID();
    await sql`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, created_by)
              VALUES (${noRevenue}::UUID, ${COMPANY}::UUID, ${'JE-' + TAG + 'NR'}, ${shift(-100)}::date,
                ${'no revenue leg ' + TAG}, 'posted', ${USER}::UUID)`;
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
              VALUES (${COMPANY}::UUID, ${noRevenue}::UUID, ${debtor!.id}::UUID, 700, 0, 'debtor'),
                     (${COMPANY}::UUID, ${noRevenue}::UUID, ${suspense!.id}::UUID, 0, 700, 'suspense')`;
    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by, gl_journal_entry_id)
      VALUES (${COMPANY}::UUID, ${cu!.id}::UUID, ${cu!.id}::UUID, ${TAG + '-NULLST'}, ${shift(-100)}::date,
        NULL, NULL, 700, 0, 0, 700, 0, ${USER}::UUID, ${noRevenue}::UUID)`;
    await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${su!.id}::UUID, ${TAG + '-NULLSB'}, ${shift(-100)}::date, ${shift(-90)}::date,
        NULL, 250, 0, 250, 0, ${USER}::UUID)`;

    // The soft-deleted pair. The chain is built directly because no service
    // can post a reversal into a fixture this thin; the fragment walks
    // gl_journal_entries only, so no lines are needed.
    for (const [kind, table, amount] of [
      ['AR', 'customer_invoices', 500],
      ['AP', 'supplier_invoices', 300],
    ] as const) {
      const original = randomUUID();
      const reversal = randomUUID();
      await sql`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, created_by)
                VALUES (${original}::UUID, ${COMPANY}::UUID, ${'JE-' + TAG + kind}, ${shift(-100)}::date,
                  ${'approval ' + TAG}, 'posted', ${USER}::UUID)`;
      await sql`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, reversal_of_id, created_by)
                VALUES (${reversal}::UUID, ${COMPANY}::UUID, ${'JE-' + TAG + kind + 'R'}, ${shift(-95)}::date,
                  ${'delete reversal ' + TAG}, 'posted', ${original}::UUID, ${USER}::UUID)`;
      const id = kind === 'AR'
        ? ((await sql`
            INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
              due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by,
              gl_journal_entry_id)
            VALUES (${COMPANY}::UUID, ${cu!.id}::UUID, ${cu!.id}::UUID, ${TAG + '-XDEL'}, ${shift(-100)}::date,
              ${shift(-90)}::date, 'approved', ${amount}, 0, 0, ${amount}, 0, ${USER}::UUID, ${original}::UUID)
            RETURNING id`) as { id: string }[])[0]!.id
        : ((await sql`
            INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
              status, subtotal, tax_amount, total_amount, amount_paid, created_by, gl_journal_entry_id)
            VALUES (${COMPANY}::UUID, ${su!.id}::UUID, ${TAG + '-YDEL'}, ${shift(-100)}::date, ${shift(-90)}::date,
              'approved', ${amount}, 0, ${amount}, 0, ${USER}::UUID, ${original}::UUID)
            RETURNING id`) as { id: string }[])[0]!.id;
      await sql.unsafe(
        `UPDATE ${table} SET deleted_at = NOW() WHERE id = $1::UUID AND company_id = $2::UUID`,
        [id, COMPANY],
      );
    }
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID AND reversal_of_id IS NOT NULL`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('null due date at a past as_at: the invoice owed then, paid since, is counted', async () => {
    const r = await invoicesNullDueDate(ctx(PAST));
    // I 1000, owed then and settled since, plus the null-STATUS invoice of 700
    // which also has no due date and is owed at every date.
    expect(r.count).toBe(2);
    expect(r.amount).toBeCloseTo(1700, 2);
    expect(r.sample.map(s => s.amount).sort((a, b) => Number(b) - Number(a))).toEqual([1000, 700]);
  });

  it('null due date today: settled, and the draft was never owed — but a null STATUS still is', async () => {
    const r = await invoicesNullDueDate(ctx(TODAY));
    expect(r.count).toBe(1);
    expect(r.amount).toBeCloseTo(700, 2);
  });

  it('test records at a past as_at carry the ageing balance then', async () => {
    const r = await testRecordsInProduction(ctx(PAST));
    expect(r.count).toBe(2);
    // 1000 + 400 settled since, plus the null-status 700 + 250.
    expect(r.amount).toBeCloseTo(2350, 2);
  });

  it('test records today carry only the null-status debt — no draft counted', async () => {
    const r = await testRecordsInProduction(ctx(TODAY));
    expect(r.count).toBe(2);
    expect(r.amount).toBeCloseTo(950, 2);
  });

  it('an issued null-status invoice whose journal moves no revenue account is reported', async () => {
    // The only posted, live invoice here whose journal has no revenue leg.
    // The soft-deleted one's chain is even, so it is out of the ledger.
    for (const asAt of [PAST, TODAY]) {
      const r = await invoicesWithoutRevenueLine(ctx(asAt));
      expect({ count: r.count, amount: r.amount, labels: r.sample.map(x => x.label) })
        .toEqual({ count: 1, amount: 700, labels: [TAG + '-NULLST'] });
    }
  });

  // The soft-deleted pair is unpaid and raised before both dates, so the ONLY
  // thing keeping its 500 + 300 out of either figure above is the ledger-parity
  // fragment on each of the two legs. Asserted here as its own statement so a
  // reader can see which mutation each number belongs to.
  it('a soft-deleted test-named document is out of the figure at every as_at', async () => {
    const [past, today] = await Promise.all([
      testRecordsInProduction(ctx(PAST)),
      testRecordsInProduction(ctx(TODAY)),
    ]);
    // AR would add 500, AP 300; both legs gone would add 800.
    expect(past.amount).toBeCloseTo(2350, 2);
    expect(today.amount).toBeCloseTo(950, 2);
    const deleted = (await sql`
      SELECT (SELECT COUNT(*)::INT FROM customer_invoices
              WHERE company_id = ${COMPANY}::UUID AND deleted_at IS NOT NULL) AS ar,
             (SELECT COUNT(*)::INT FROM supplier_invoices
              WHERE company_id = ${COMPANY}::UUID AND deleted_at IS NOT NULL) AS ap
    `) as { ar: number; ap: number }[];
    expect(deleted[0]).toEqual({ ar: 1, ap: 1 });
  });
});
