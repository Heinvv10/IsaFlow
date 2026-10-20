/**
 * D7 (2026-10-02) — a soft-deleted document's reversal chain is never a
 * `posting_with_no_document`, however far the chain has been extended by hand.
 *
 * The sub-ledger side decides whether a soft-deleted document is in the ledger
 * by the PARITY of its journal's reversal chain as at the date
 * (shared/softDeleteLedgerPresence). The reconciliation's itemisation has to
 * read that same chain the same way, or the decomposition stops summing:
 * `unappliedCashService` mechanism 2 used to exclude only the ONE entry recorded
 * in `soft_delete_journal_reversals`, so once that entry R had itself been
 * reversed by hand (R2), R2 had no partner left for `dropCancelledReversalPairs`
 * and was itemised as an orphan for the document's full gross value, with an
 * equal and opposite `unexplained_difference` — on books that tie, and the AR
 * and AP close-readiness checks FAILED on it.
 *
 * Every step below is a ledger that ties, and every surface must say so with no
 * reconciling item at all: `reconcileSubledger`, the MCP `reconcile_subledger`
 * tool that wraps it, the AR/AP close checks, and the aging.
 *
 *   1. delete, then reverse R by hand, dated TOMORROW: at TODAY the document is
 *      out (O, R), at TOMORROW it is back (O, R, R2) — the reported defect.
 *   2. reverse R2 by hand: out again (O, R, R2, R3). A fix that merely let R
 *      pair with R2 passes step 1 and itemises R3 here.
 *   3. reverse R3 by hand: back again (O, R, R2, R3, R4).
 *   4. a second document whose journal was reversed by hand BEFORE the delete:
 *      the delete posts nothing and records no row, so only the chain says the
 *      hand reversal M belongs to a document the sub-ledger side has dropped.
 *   5. the mirror: a LIVE document whose journal is reversed by hand. The
 *      control account has moved and the sub-ledger has not, so that reversal
 *      IS a reconciling item and must still be itemised — the exclusion is for
 *      deleted documents only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { McpToolContext } from '@/lib/mcp/types';
import { reconcileSubledgerTool } from '@/lib/mcp/tools/reconcileSubledger';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { arSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `D7CHAIN-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const TOMORROW = shift(1);
const CLOSED_END = shift(-60);
const OPEN_START = shift(-59);
const OPEN_END = shift(400);
const DOC_DATE = shift(-120);
const DUE_DATE = shift(-100);

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;
/** The second document, a different amount so a mis-attribution cannot hide. */
const SUB_B = 400;
const VAT_B = 60;
const GROSS_B = SUB_B + VAT_B;
/** A LIVE document, for the mirror direction. */
const SUB_C = 200;
const VAT_C = 30;
const GROSS_C = SUB_C + VAT_C;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();

const CTX = { userId: USER, companyId: COMPANY, scopes: ['read:reports'],
  companyRole: 'owner', tokenJti: 'jti', oauthAppId: 'app' } as McpToolContext;

let customer: string;
let supplier: string;
/** role -> the head of the chain the next hand reversal reverses. */
const head: Record<'ar' | 'ap', string> = { ar: '', ap: '' };

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

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

async function arInvoice(suffix: string, sub: number, vat: number): Promise<string> {
  const id = ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + suffix}, ${DOC_DATE}::date,
      ${DUE_DATE}::date, 'approved', ${sub}, 15, ${vat}, ${sub + vat}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await inTx(() => postCustomerInvoiceToGL(COMPANY, id, USER));
  return id;
}

async function apBill(suffix: string, sub: number, vat: number): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + suffix}, ${DOC_DATE}::date, ${DUE_DATE}::date,
      'approved', ${sub}, ${vat}, ${sub + vat}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, ${'D7 line'}, 1, ${sub}, 15, ${vat}, ${sub}, ${expense}::UUID)`;
  await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
  return id;
}

async function journalOf(id: string): Promise<string> {
  return ((await sql`
    SELECT gl_journal_entry_id AS j FROM customer_invoices WHERE company_id = ${COMPANY}::UUID AND id = ${id}::UUID
    UNION ALL
    SELECT gl_journal_entry_id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID AND id = ${id}::UUID`) as { j: string }[])[0]!.j;
}

/** Post a document pair into the prior period, which is closed again afterwards. */
async function postInPriorPeriod(suffix: string, sub: number, vat: number): Promise<[string, string]> {
  await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;
  const pair: [string, string] = [await arInvoice('-AR' + suffix, sub, vat), await apBill('-AP' + suffix, sub, vat)];
  await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;
  return pair;
}

/** Reverse the current head of `role`'s chain by hand, dated TOMORROW. */
async function reverseHeadByHand(role: 'ar' | 'ap'): Promise<void> {
  const rev = await inTx(() => reverseJournalEntry(COMPANY, head[role], USER, { reversalDate: TOMORROW }));
  head[role] = rev.id;
}

/**
 * The whole claim, on every surface: the reconciliation ties with NO
 * reconciling item, the MCP tool returns the same empty itemisation, the close
 * check passes, and the aging carries exactly `expected`.
 */
async function assertTiesWithNoItems(role: 'ar' | 'ap', asAt: string, expected: number): Promise<void> {
  const rec = await reconcileSubledger(COMPANY, role, asAt);
  expect(rec.reconcilingItems.map((i) => `${i.type} ${i.amount}`)).toEqual([]);
  expect(rec.unexplainedDifference).toBe(0);
  expect(rec.subledgerTotal).toBeCloseTo(expected, 2);
  expect(rec.invariants.every((v) => v.holds)).toBe(true);

  const res = await reconcileSubledgerTool.handler({ subledger: role, as_at: asAt }, CTX);
  expect((JSON.parse(res.content[0]!.text) as { rows: unknown[] }).rows).toEqual([]);

  const check = role === 'ar'
    ? await arSubLedgerCheck(COMPANY, { endDate: asAt })
    : await apSubLedgerCheck(COMPANY, { endDate: asAt });
  expect(check.reason).not.toContain('posting_with_no_document');
  expect(check.status).toBe('pass');

  const aged = role === 'ar'
    ? (await getARAging(COMPANY, asAt)).find((b) => b.entityId === customer)?.total ?? 0
    : (await getAPAging(COMPANY, asAt)).find((b) => b.entityId === supplier)?.total ?? 0;
  expect(aged).toBeCloseTo(expected, 2);
}

describeIfDb('D7 a deleted document\'s reversal chain is never itemised', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'D7CHAIN ' + TAG}, ${TAG})`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'D7CHAIN prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'D7CHAIN current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const [ar, ap] = await postInPriorPeriod('', SUB, VAT);
    await inTx(() => softDelete(COMPANY, 'customer_invoice', ar, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', ap, USER));
    const recorded = (await sql`
      SELECT entity_type, reversal_journal_entry_id AS id FROM soft_delete_journal_reversals
      WHERE company_id = ${COMPANY}::UUID
    `) as { entity_type: string; id: string }[];
    head.ar = recorded.find((r) => r.entity_type === 'customer_invoice')!.id;
    head.ap = recorded.find((r) => r.entity_type === 'supplier_invoice')!.id;
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
                (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${payable}::UUID, ${revenue}::UUID, ${expense}::UUID, ${vatOutput}::UUID, ${vatInput}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 120000);

  for (const role of ['ar', 'ap'] as const) {
    it(`${role}: the deleted document ties with nothing itemised (premise)`, async () => {
      await assertTiesWithNoItems(role, TODAY, 0);
    });

    it(`${role}: the delete reversal reversed by hand — out today, back tomorrow, no item either day`, async () => {
      await reverseHeadByHand(role);
      await assertTiesWithNoItems(role, TODAY, 0);
      await assertTiesWithNoItems(role, TOMORROW, GROSS);
    });

    it(`${role}: that hand reversal reversed by hand again — out, no item`, async () => {
      await reverseHeadByHand(role);
      await assertTiesWithNoItems(role, TOMORROW, 0);
    });

    it(`${role}: and once more — back, no item`, async () => {
      await reverseHeadByHand(role);
      await assertTiesWithNoItems(role, TOMORROW, GROSS);
    });
  }

  it('a journal reversed by hand BEFORE the delete is not itemised once the document is deleted', async () => {
    const [ar, ap] = await postInPriorPeriod('-B', SUB_B, VAT_B);
    const arJournal = await journalOf(ar);
    const apJournal = await journalOf(ap);
    await inTx(() => reverseJournalEntry(COMPANY, arJournal, USER));
    await inTx(() => reverseJournalEntry(COMPANY, apJournal, USER));
    await inTx(() => softDelete(COMPANY, 'customer_invoice', ar, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', ap, USER));

    // The premise: the delete found the journal already out of the ledger, so
    // it posted nothing and recorded no row for either document.
    const recorded = (await sql`
      SELECT COUNT(*)::int AS n FROM soft_delete_journal_reversals
      WHERE company_id = ${COMPANY}::UUID AND entity_id IN (${ar}::UUID, ${ap}::UUID)
    `) as { n: number }[];
    expect(recorded[0]!.n).toBe(0);

    // The first documents' chains stand (odd) as at TOMORROW, so they carry GROSS.
    await assertTiesWithNoItems('ar', TOMORROW, GROSS);
    await assertTiesWithNoItems('ap', TOMORROW, GROSS);
  });

  it('the mirror: a LIVE document\'s hand-reversed journal is still itemised, and explains the gap', async () => {
    const [ar, ap] = await postInPriorPeriod('-C', SUB_C, VAT_C);
    const arJournal = await journalOf(ar);
    const apJournal = await journalOf(ap);
    const arM = (await inTx(() => reverseJournalEntry(COMPANY, arJournal, USER))).id;
    const apM = (await inTx(() => reverseJournalEntry(COMPANY, apJournal, USER))).id;

    for (const [role, m] of [['ar', arM], ['ap', apM]] as const) {
      const rec = await reconcileSubledger(COMPANY, role, TOMORROW);
      expect(rec.reconcilingItems.map((i) => `${i.type} ${i.amount}`)).toEqual([
        `posting_with_no_document ${GROSS_C}`,
      ]);
      expect(JSON.stringify(rec.reconcilingItems)).toContain(m);
      expect(rec.unexplainedDifference).toBe(0);
      expect(rec.subledgerTotal).toBeCloseTo(GROSS + GROSS_C, 2);
    }
  });
});
