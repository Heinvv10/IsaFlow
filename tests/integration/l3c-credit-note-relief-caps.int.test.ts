/**
 * L3c — the three guards on credit-note relief, each on a shape the services
 * cannot currently produce.
 *
 * WHY FORGED ROWS. `creditNoteRelief` caps a document's relief at the credit
 * that actually reached a control account, floors that cap at zero, and bounds
 * it by the note's own `credit_date`. None of the three can be exercised
 * through `approveCreditNote`: it posts a journal for the note's full value, in
 * the right direction, dated from the note. Driven only through the services,
 * every guard is inert — each one can be deleted and l3b stays green — so the
 * shapes are built directly here. They are not hypothetical: a part-posted
 * note, a wrong-direction journal and a note whose journal predates it all
 * exist on the production copy this reconciler is measured against.
 *
 * ASSERTED PER DOCUMENT, through `getUnpostedSubledgerDocuments` rather than
 * through the reconciler's grouped item. The item sums every document in the
 * company, so one case's figure hides inside another's and a guard can be
 * removed without the total moving. `reconcileSubledger` is still run once, for
 * the invariants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getControlAccountBalances } from '@/modules/accounting/services/gl/controlAccountService';
import { getUnpostedSubledgerDocuments } from '@/modules/accounting/services/reconciliation/unpostedDocumentService';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `L3D${Math.floor(Math.random() * 1e8)}`;

const DOC_DATE = '2026-03-01';
const SETTLE_DATE = '2026-03-15';
/** After the as-at date: a note not yet in force at the reporting date. */
const LATE_DATE = '2026-08-15';
const AS_AT = '2026-06-30';
const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;

let payable = '';
let expense = '';
let supplier = '';
let partA = '';
let partB = '';
let cancelledBill = '';
let lateBill = '';
let wrongWayBill = '';

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

async function account(
  code: string, name: string, type: string, normal: string, subtype: string | null,
): Promise<string> {
  return ((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})
    RETURNING id`) as { id: string }[])[0]!.id;
}

/** An approved bill posted through the real workflow, settled by `paid`. */
async function bill(n: string, paid: number): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${DOC_DATE}::date, ${DOC_DATE}::date,
      'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'L3c line', 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;
  await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
  if (paid !== 0) {
    await sql`UPDATE supplier_invoices SET amount_paid = ${paid}
              WHERE id = ${id}::UUID AND company_id = ${COMPANY}::UUID`;
  }
  return id;
}

/**
 * A posted journal moving the payable by `onControl` — negative to move it the
 * way a supplier credit note never should.
 */
async function journal(n: string, date: string, onControl: number, reversalOf?: string): Promise<string> {
  const id = ((await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description,
      status, source, created_by, reversal_of_id)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${date}::date, ${'L3c ' + n}, 'posted',
      'auto_credit_note', ${USER}::UUID, ${reversalOf ?? null})
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
    VALUES (${COMPANY}::UUID, ${id}::UUID, ${payable}::UUID,
            ${onControl > 0 ? onControl : 0}, ${onControl < 0 ? -onControl : 0}),
           (${COMPANY}::UUID, ${id}::UUID, ${expense}::UUID,
            ${onControl < 0 ? -onControl : 0}, ${onControl > 0 ? onControl : 0})`;
  return id;
}

/** A credit note in whatever state the case needs, with its allocation rows. */
async function note(args: {
  n: string; total: number; applied: number; status: string; creditDate: string;
  journalId: string; linkedTo?: string; allocations: Array<{ invoiceId: string; amount: number }>;
}): Promise<string> {
  const id = ((await sql`
    INSERT INTO credit_notes (company_id, type, supplier_id, supplier_invoice_id,
      credit_note_number, credit_date, subtotal, tax_amount, total_amount, status,
      applied_amount, gl_journal_entry_id, created_by)
    VALUES (${COMPANY}::UUID, 'supplier', ${supplier}::UUID, ${args.linkedTo ?? null},
      ${TAG + args.n}, ${args.creditDate}::date, ${args.total}, 0, ${args.total}, ${args.status},
      ${args.applied}, ${args.journalId}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  for (const a of args.allocations) {
    await sql`
      INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
      VALUES (${COMPANY}::UUID, ${id}::UUID, ${a.invoiceId}::UUID, ${a.amount})`;
  }
  return id;
}

async function unposted() {
  const ids = (await getControlAccountBalances(COMPANY, 'ap', AS_AT)).map((a) => a.accountId);
  expect(ids).toHaveLength(1);
  return getUnpostedSubledgerDocuments(COMPANY, 'ap', AS_AT, ids);
}

describeIfDb('L3c — the cap, the floor and the as-at bound on credit-note relief', () => {
  beforeAll(async () => {
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'L3c ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year,
                start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'L3c ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;

    payable = await account('2110', 'Trade Creditors', 'liability', 'credit', 'payable');
    expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account('1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    await account('1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
      VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    // ── PART-POSTED, SPLIT TWO WAYS. The note says it consumed 100 and its
    // journal put only 60 on the control account. Each allocation may take its
    // own SHARE of that 60 — 50/100 of it, so 30 — and no more. A flat cap of
    // 60 per document binds on neither 50 and relieves the full 100, which is
    // 40 the ledger never received.
    partA = await bill('-PART-A', 50);
    partB = await bill('-PART-B', 50);
    await note({
      n: '-PART-CN', total: 100, applied: 100, status: 'applied', creditDate: SETTLE_DATE,
      journalId: await journal('-PART-JE', SETTLE_DATE, 60),
      allocations: [{ invoiceId: partA, amount: 50 }, { invoiceId: partB, amount: 50 }],
    });

    // ── CANCELLED, WITH ITS ROWS STILL IN PLACE. `cancelCreditNote` deletes
    // the rows and zeroes applied_amount, so a cancelled note reaches the
    // reconciler with nothing to attribute and the status guard is never the
    // reason it relieves nothing. This is the inconsistent shape — reversed on
    // the ledger, still claiming an application — and only the status guard
    // stops it relieving a bill that is open in full.
    cancelledBill = await bill('-CANCELLED', 0);
    const original = await journal('-CANCELLED-JE', SETTLE_DATE, GROSS);
    await journal('-CANCELLED-REV', SETTLE_DATE, -GROSS, original);
    await note({
      n: '-CANCELLED-CN', total: GROSS, applied: GROSS, status: 'cancelled',
      creditDate: SETTLE_DATE, journalId: original, linkedTo: cancelledBill,
      allocations: [{ invoiceId: cancelledBill, amount: GROSS }],
    });

    // ── RAISED AFTER THE AS-AT DATE, POSTED BEFORE IT. `agingRewind` puts this
    // credit back, so at the as-at date the subledger carries the bill in full;
    // relieving the control side by the note's journal date would report the
    // bill as over-represented by its whole value. The two sides must be dated
    // the same way, and the note's own date is the one the aging uses.
    lateBill = await bill('-LATE', GROSS);
    await note({
      n: '-LATE-CN', total: GROSS, applied: GROSS, status: 'applied', creditDate: LATE_DATE,
      journalId: await journal('-LATE-JE', DOC_DATE, GROSS), linkedTo: lateBill,
      allocations: [{ invoiceId: lateBill, amount: GROSS }],
    });

    // ── MOVED THE CONTROL ACCOUNT THE WRONG WAY. A supplier note DEBITS the
    // payable; this one credits it. Unfloored, the cap goes NEGATIVE and the
    // relief RAISES the bill's control amount, so the item claims twice what
    // the bill it cites is worth.
    wrongWayBill = await bill('-WRONGWAY', GROSS);
    await note({
      n: '-WRONGWAY-CN', total: GROSS, applied: GROSS, status: 'applied', creditDate: SETTLE_DATE,
      journalId: await journal('-WRONGWAY-JE', SETTLE_DATE, -GROSS),
      allocations: [{ invoiceId: wrongWayBill, amount: GROSS }],
    });
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID
              AND reversal_of_id IS NOT NULL`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 120000);

  it('gives each allocation its SHARE of a part-posted note, never the whole cap', async () => {
    const docs = await unposted();
    // 30 of the 60 reached each bill, against 50 the subledger took off it: the
    // bill is 20 short on the control account and the reconciler says so. A
    // flat cap reports nothing at all and the 40 the ledger never received
    // disappears from the reconciliation.
    expect(docs.find((d) => d.id === partA)?.amount).toBeCloseTo(-20, 2);
    expect(docs.find((d) => d.id === partB)?.amount).toBeCloseTo(-20, 2);
  }, 120000);

  it('a CANCELLED note relieves nothing even with allocation rows and an applied amount', async () => {
    const docs = await unposted();
    expect(docs.find((d) => d.id === cancelledBill)).toBeUndefined();
  }, 120000);

  it('a note raised AFTER the as-at date relieves nothing at it, whatever its journal is dated', async () => {
    // The subledger side rewinds this credit, so the bill is outstanding in
    // full at the as-at date; the control side must agree, and does, which is
    // what "no finding for this bill" means here.
    const docs = await unposted();
    expect(docs.find((d) => d.id === lateBill)).toBeUndefined();
  }, 120000);

  it('a note whose journal moved the control account the WRONG way relieves nothing', async () => {
    const docs = await unposted();
    // The bill is settled in the subledger and its own journal is all that
    // reached the control account, so the finding is the bill's full value --
    // once. Unfloored it is reported as 2,300 against a bill worth 1,150.
    const doc = docs.find((d) => d.id === wrongWayBill);
    expect(doc?.amount).toBeCloseTo(-GROSS, 2);
    expect(Math.abs(doc!.amount)).toBeLessThanOrEqual(doc!.gross);
  }, 120000);

  it('every invariant holds on this set of forged shapes', async () => {
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    for (const inv of rec.invariants) {
      expect(inv, `${inv.name}: ${inv.detail}`).toMatchObject({ holds: true });
    }
  }, 120000);
});
