/**
 * R-059 round 6 — reconcile_subledger on a MIXED population ties to zero and
 * names nothing false, on both bridges and on both sides.
 *
 * Rounds 4 and 5 each moved a residual between the two bridges instead of
 * removing it: a null-status document was in one side's population and not the
 * other's, and the reconciliation reported books that tie to the cent as a
 * named item plus an equal and opposite unexplained difference. The status rule
 * now lives in one place (shared/documentPopulation); this pins the outcome.
 *
 * Every document is driven through the REAL posting services — invoice
 * posting, payment confirm/process, credit-note approval, write-off approval —
 * so each journal is linked to its document by the columns production writes,
 * not by columns this test chose. Each side carries:
 *   A   issued, posted, open                      in both populations
 *   N   issued, posted, then status set to NULL    in both (the R-059 row);
 *       on AP it is also payment_matched, so settlementFlagged must carry it
 *   D   draft, never posted                        in neither
 *   C   cancelled, never posted                    in neither
 *   CN  posted, then credit-noted 230 (linked)     in both, 920 open
 *   PP  posted, then part-paid 400 (allocated)     in both, 750 open
 *   WO  AR only: posted, then written off 150      in both, 1000 open
 * At a past date between the documents and the settlements, and at today:
 * agedTotal == subledgerTotal == control; difference 0; unexplained 0; and
 * reconcilingItems EMPTY — not merely summing to zero.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { postCustomerInvoiceToGL, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { processSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createWriteOff, approveWriteOff } from '@/modules/accounting/services/ar/writeOffService';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R59M${Math.floor(Math.random() * 1e8)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const DOC = shift(-60);
const DUE = shift(-30);
const PAST = shift(-45);
const SETTLED = shift(-20);
const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;

let customer = '';
let supplier = '';
let expense = '';

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: USER, companyId: COMPANY, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function account(code: string, name: string, type: string, normal: string, subtype: string): Promise<string> {
  return ((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function arDoc(n: string, status: string, post: boolean): Promise<string> {
  const id = ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + n}, ${DOC}::date,
      ${DUE}::date, ${status}, ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  if (post) await inTx(() => postCustomerInvoiceToGL(COMPANY, id, USER));
  return id;
}

async function apDoc(n: string, status: string, post: boolean): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${DOC}::date, ${DUE}::date,
      ${status}, ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, ${'R059 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;
  if (post) await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
  return id;
}

async function creditNote(type: 'customer' | 'supplier', invoice: string): Promise<void> {
  const id = ((await sql`
    INSERT INTO credit_notes (company_id, type, client_id, supplier_id, customer_invoice_id, supplier_invoice_id,
      credit_note_number, credit_date, subtotal, tax_amount, total_amount, status, created_by, applied_amount)
    VALUES (${COMPANY}::UUID, ${type},
      ${type === 'customer' ? customer : null}::UUID, ${type === 'supplier' ? supplier : null}::UUID,
      ${type === 'customer' ? invoice : null}::UUID, ${type === 'supplier' ? invoice : null}::UUID,
      ${TAG + '-CN' + type.slice(0, 1)}, ${SETTLED}::date, 200, 30, 230, 'draft', ${USER}::UUID, 0)
    RETURNING id`) as { id: string }[])[0]!.id;
  await inTx(() => approveCreditNote(COMPANY, id, USER));
}

describeIfDb('R-059 reconcile_subledger ties to zero on a mixed population', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059RM ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'R059RM ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;
    await account('1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account('2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account('1000', 'Bank', 'asset', 'debit', 'bank');
    await account('4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account('6100', 'Bad debts', 'expense', 'debit', 'admin_expense');
    await account('2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account('1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    // AR
    await arDoc('-AR-A', 'approved', true);
    const arN = await arDoc('-AR-N', 'approved', true);
    await sql`UPDATE customer_invoices SET status = NULL WHERE id = ${arN}::UUID AND company_id = ${COMPANY}::UUID`;
    await arDoc('-AR-D', 'draft', false);
    await arDoc('-AR-C', 'cancelled', false);
    await creditNote('customer', await arDoc('-AR-CN', 'approved', true));
    const arPP = await arDoc('-AR-PP', 'approved', true);
    const cp = ((await sql`
      INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + '-CP'}, ${customer}::UUID, ${SETTLED}::date, 400, 'draft', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${cp}::UUID, ${arPP}::UUID, 400)`;
    await inTx(() => confirmCustomerPayment(COMPANY, cp, USER));
    const arWO = await arDoc('-AR-WO', 'approved', true);
    const wo = await createWriteOff(COMPANY, { clientId: customer, invoiceId: arWO, amount: 150, reason: 'R059', writeOffDate: SETTLED }, USER);
    await inTx(() => approveWriteOff(COMPANY, wo.id, USER));

    // AP
    await apDoc('-AP-A', 'approved', true);
    const apN = await apDoc('-AP-N', 'approved', true);
    // N is also payment_matched — a matching process believed it settled — so
    // settlementFlagService, which claims the subledger's population, has a
    // null-status row to keep or drop.
    await sql`UPDATE supplier_invoices SET status = NULL, payment_matched = TRUE
              WHERE id = ${apN}::UUID AND company_id = ${COMPANY}::UUID`;
    await apDoc('-AP-D', 'draft', false);
    await apDoc('-AP-C', 'cancelled', false);
    await creditNote('supplier', await apDoc('-AP-CN', 'approved', true));
    const apPP = await apDoc('-AP-PP', 'approved', true);
    const sp = ((await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + '-SP'}, ${supplier}::UUID, ${SETTLED}::date, 400, 'approved', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${sp}::UUID, ${apPP}::UUID, 400)`;
    await inTx(() => processSupplierPayment(COMPANY, sp, USER));
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_write_offs WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID AND reversal_of_id IS NOT NULL`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 180000);

  it('the premise: the null-status rows exist and are posted', async () => {
    const [r] = (await sql`
      SELECT (SELECT COUNT(*)::INT FROM customer_invoices WHERE company_id = ${COMPANY}::UUID
              AND status IS NULL AND gl_journal_entry_id IS NOT NULL) AS ar,
             (SELECT COUNT(*)::INT FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID
              AND status IS NULL AND gl_journal_entry_id IS NOT NULL) AS ap
    `) as { ar: number; ap: number }[];
    expect(r).toEqual({ ar: 1, ap: 1 });
  });

  // A, N, CN, PP (and WO on AR), each GROSS 1150 when raised.
  const CASES = [
    { role: 'ar' as const, asAt: PAST, open: 5 * GROSS },
    { role: 'ar' as const, asAt: TODAY, open: 2 * GROSS + (GROSS - 230) + (GROSS - 400) + (GROSS - 150) },
    { role: 'ap' as const, asAt: PAST, open: 4 * GROSS },
    { role: 'ap' as const, asAt: TODAY, open: 2 * GROSS + (GROSS - 230) + (GROSS - 400) },
  ];

  it('AP: the null-status bill a matching process flagged is IN settlementFlagged', async () => {
    // settlementFlagService says its population is the subledger's exactly —
    // same status rule. The flagged bill is open (1150) and in the subledger,
    // so it must be here; the bare spelling dropped it.
    for (const asAt of [PAST, TODAY]) {
      const r = await inTx(() => reconcileSubledger(COMPANY, 'ap', asAt));
      expect({ count: r.settlementFlagged.count, total: r.settlementFlagged.total })
        .toEqual({ count: 1, total: GROSS });
    }
  });

  for (const c of CASES) {
    it(`${c.role.toUpperCase()} at ${c.asAt === TODAY ? 'today' : 'a past date'}: every bridge is 0 and nothing is named`, async () => {
      const r = await inTx(() => reconcileSubledger(COMPANY, c.role, c.asAt));
      // Printed whole on failure, so a red run says WHICH item is false.
      expect({
        aged: r.agedTotal, subledger: r.subledgerTotal, control: r.controlAccountBalance,
        difference: r.difference, unexplained: r.unexplainedDifference, items: r.reconcilingItems,
      }).toEqual({
        aged: c.open, subledger: c.open, control: c.open,
        difference: 0, unexplained: 0, items: [],
      });
    });
  }
});
