/**
 * K-053 round 8 (H-1) — the delete's reversal is not a reconciling item, and
 * excluding it does not blind the partition it sits in.
 *
 * `unappliedCashService` mechanism 2 reports every posted control movement that
 * NO subledger document references. The reversal a soft-delete posts is exactly
 * such a movement — the invoice deliberately keeps pointing at the ORIGINAL
 * entry so the undo can find it — so before this fix every soft-deleted invoice
 * left a permanent orphan line for its full gross value on the AR reconciler
 * and on the AP reconciler.
 *
 * A guard fails in both directions, so this fixture carries BOTH shapes on one
 * control account: the delete's reversal, which must NOT be reported, and a
 * bare journal that credits the debtor with no document behind it — mechanism
 * 2's original reason for existing (FINDINGS B24) — which must still be.
 *
 * Round 10 adds the direction round 8 asserted but never exercised: the UNDO.
 * `reinstateInvoiceJournal` DELETEs the `soft_delete_journal_reversals` row and
 * posts R2 reversing R, so after a delete/undo round trip neither R nor R2 is
 * claimed by a document or by an sdjr row and both passed every `NOT EXISTS` —
 * two phantom orphans for the document's full gross value each, on a document
 * that is restored and perfectly reconciled. `dropCancelledReversalPairs`
 * (reconciliation/orphanReversalPairs) drops them, and the third shape in this
 * fixture proves it does not over-reach: a bare journal reversed by hand LATER,
 * which must still be reported at an as-at date that sees only its first leg.
 *
 * Round 12 runs the round trip AGAIN, and a third time. One cycle could not see
 * the defect: with only R and R2 there is one pair and any order finds it. From
 * the second cycle the chain is O <- R <- R2 <- R3 <- R4, every delete reversal
 * is dated TODAY, and `ORDER BY je.entry_date, je.id` therefore leaves a random
 * UUID deciding which link a greedy pass reaches first — R3 pairing with R2 and
 * leaving R and R4 reported for the document's full gross value each. The
 * orderings themselves are pinned deterministically in the sibling unit test
 * `tests/unit/services/reconciliation/orphanReversalPairs.test.ts`; what these
 * cases add is that a real `softDelete`/`undoDelete` builds exactly that chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getUnappliedControlCash } from '@/modules/accounting/services/reconciliation/unappliedCashService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053ORPH-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const CLOSED_END = shift(-60);
const OPEN_START = shift(-59);
const OPEN_END = shift(400);
const DOC_DATE = shift(-120);
/** Inside the closed period, after the document, well before the delete. */
const AS_AT_BEFORE = shift(-90);
/** The bare journal sits in the closed period too, so both dates see it. */
const ORPHAN_DATE = shift(-100);

/** The hand-reversed pair: the credit sits before both as-at dates... */
const PAIR_DATE = shift(-101);
/** ...and its reversal after the earlier one, so only TODAY sees the pair. */
const PAIR_REV_DATE = shift(-5);

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;
const ORPHAN = 500;
const PAIR = 700;

const receivable = randomUUID();
const revenue = randomUUID();
const vatOutput = randomUUID();
const bank = randomUUID();

let customer: string;
let invoice: string;
let orphanEntry: string;
let pairEntry: string;
let pairReversal: string;

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

describeIfDb('K-053 a soft-delete reversal is not an unapplied-cash orphan', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053ORPH ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053ORPH prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053ORPH current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(bank, '1010', 'Bank', 'asset', 'debit', 'bank');

    customer = ((await sql`INSERT INTO customers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    invoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR'}, ${DOC_DATE}::date,
        ${DOC_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await inTx(() => postCustomerInvoiceToGL(COMPANY, invoice, USER));

    // Mechanism 2's own case: cash on the control account with no payment row
    // behind it, because allocateTransaction skipped its INSERT (FINDINGS B24).
    orphanEntry = randomUUID();
    await sql`
      INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
        status, source, created_by)
      VALUES (${orphanEntry}::UUID, ${COMPANY}::UUID, ${'JE-ORPH-' + TAG}, ${ORPHAN_DATE}::date,
        ${'Receipt with no payment row ' + TAG}, 'posted', 'manual', ${USER}::UUID)`;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${COMPANY}::UUID, ${orphanEntry}::UUID, ${bank}::UUID, ${ORPHAN}, 0, ${'receipt'}),
             (${COMPANY}::UUID, ${orphanEntry}::UUID, ${receivable}::UUID, 0, ${ORPHAN}, ${'receipt'})`;

    // A bare control movement that IS cancelled, by a reversal dated later.
    // At AS_AT_BEFORE only its first leg exists, so it must still be reported;
    // at TODAY the pair nets to nothing and neither leg is a reconciling item.
    pairEntry = randomUUID();
    pairReversal = randomUUID();
    await sql`
      INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
        status, source, created_by)
      VALUES (${pairEntry}::UUID, ${COMPANY}::UUID, ${'JE-PAIR-' + TAG}, ${PAIR_DATE}::date,
        ${'Receipt later reversed by hand ' + TAG}, 'posted', 'manual', ${USER}::UUID)`;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${COMPANY}::UUID, ${pairEntry}::UUID, ${bank}::UUID, ${PAIR}, 0, ${'receipt'}),
             (${COMPANY}::UUID, ${pairEntry}::UUID, ${receivable}::UUID, 0, ${PAIR}, ${'receipt'})`;
    await sql`
      INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
        status, source, created_by, reversal_of_id)
      VALUES (${pairReversal}::UUID, ${COMPANY}::UUID, ${'JE-PAIRREV-' + TAG}, ${PAIR_REV_DATE}::date,
        ${'Reversal of the bare receipt ' + TAG}, 'posted', 'manual', ${USER}::UUID,
        ${pairEntry}::UUID)`;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${COMPANY}::UUID, ${pairReversal}::UUID, ${bank}::UUID, 0, ${PAIR}, ${'reversal'}),
             (${COMPANY}::UUID, ${pairReversal}::UUID, ${receivable}::UUID, ${PAIR}, 0, ${'reversal'})`;

    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;
    await inTx(() => softDelete(COMPANY, 'customer_invoice', invoice, USER));
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${revenue}::UUID, ${vatOutput}::UUID, ${bank}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the delete reversed the approval journal, dated TODAY', async () => {
    const rows = (await sql`
      SELECT e.id, e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID
    `) as { id: string; entry_date: unknown }[];
    expect(rows).toHaveLength(1);
    expect(fmtDate(new Date(String(rows[0]!.entry_date)))).toBe(TODAY);
    // And no document points at it — which is why it reached mechanism 2.
    const claimed = (await sql`
      SELECT COUNT(*)::int AS n FROM customer_invoices
      WHERE company_id = ${COMPANY}::UUID AND gl_journal_entry_id = ${rows[0]!.id}::UUID
    `) as { n: number }[];
    expect(claimed[0]!.n).toBe(0);
  });

  it('reports the bare journal and NOT the delete reversal, at both dates', async () => {
    // Earlier date: the hand-reversed pair has only its first leg posted, so it
    // is a genuine reconciling item and must be reported alongside the orphan.
    const before = await getUnappliedControlCash(COMPANY, 'ar', AS_AT_BEFORE, [receivable]);
    expect(before.withoutPaymentRecord.map((i) => i.id)).toEqual([pairEntry, orphanEntry]);
    expect(before.total).toBeCloseTo(PAIR + ORPHAN, 2);

    // Today: the pair has netted to nothing and drops out; the orphan, which
    // nothing reverses, is still found; and the delete's reversal, worth the
    // whole document, never appears at either date.
    const today = await getUnappliedControlCash(COMPANY, 'ar', TODAY, [receivable]);
    expect(today.withoutPaymentRecord.map((i) => i.id)).toEqual([orphanEntry]);
    expect(today.withoutPaymentRecord[0]!.amount).toBeCloseTo(ORPHAN, 2);
    expect(today.total).toBeCloseTo(ORPHAN, 2);
  });

  it('after a delete/undo round trip neither leg is a reconciling item', async () => {
    await inTx(() => undoDelete(COMPANY, 'customer_invoice', invoice, USER));

    // The premise: the undo removed the sdjr row that had been excluding R, and
    // posted R2, so BOTH now pass every NOT EXISTS the query makes.
    const sdjr = (await sql`
      SELECT COUNT(*)::int AS n FROM soft_delete_journal_reversals
      WHERE company_id = ${COMPANY}::UUID
    `) as { n: number }[];
    expect(sdjr[0]!.n).toBe(0);
    const chain = (await sql`
      SELECT COUNT(*)::int AS n FROM gl_journal_entries je
      WHERE je.company_id = ${COMPANY}::UUID AND je.status = 'posted'
        AND je.reversal_of_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM customer_invoices d
                        WHERE d.company_id = ${COMPANY}::UUID AND d.gl_journal_entry_id = je.id)
    `) as { n: number }[];
    // R, R2 and the hand-built pair reversal.
    expect(chain[0]!.n).toBe(3);

    const cash = await getUnappliedControlCash(COMPANY, 'ar', TODAY, [receivable]);
    expect(cash.withoutPaymentRecord.map((i) => i.id)).toEqual([orphanEntry]);
    expect(cash.total).toBeCloseTo(ORPHAN, 2);
  });

  it('a SECOND round trip extends the chain and still leaves nothing behind', async () => {
    await inTx(() => softDelete(COMPANY, 'customer_invoice', invoice, USER));
    await inTx(() => undoDelete(COMPANY, 'customer_invoice', invoice, USER));

    // The premise: four unclaimed reversals on the document's chain now, all
    // dated TODAY, so nothing but the chain itself distinguishes their order.
    const chain = (await sql`
      SELECT COUNT(*)::int AS n FROM gl_journal_entries je
      WHERE je.company_id = ${COMPANY}::UUID AND je.status = 'posted'
        AND je.reversal_of_id IS NOT NULL
        AND je.entry_date = ${TODAY}::date
        AND NOT EXISTS (SELECT 1 FROM customer_invoices d
                        WHERE d.company_id = ${COMPANY}::UUID AND d.gl_journal_entry_id = je.id)
    `) as { n: number }[];
    expect(chain[0]!.n).toBe(4);

    const restored = (await sql`
      SELECT deleted_at FROM customer_invoices
      WHERE company_id = ${COMPANY}::UUID AND id = ${invoice}::UUID
    `) as { deleted_at: unknown }[];
    expect(restored[0]!.deleted_at).toBeNull();

    const cash = await getUnappliedControlCash(COMPANY, 'ar', TODAY, [receivable]);
    expect(cash.withoutPaymentRecord.map((i) => i.id)).toEqual([orphanEntry]);
    expect(cash.total).toBeCloseTo(ORPHAN, 2);
  });

  it('a THIRD round trip is no different', async () => {
    await inTx(() => softDelete(COMPANY, 'customer_invoice', invoice, USER));
    await inTx(() => undoDelete(COMPANY, 'customer_invoice', invoice, USER));

    const chain = (await sql`
      SELECT COUNT(*)::int AS n FROM gl_journal_entries je
      WHERE je.company_id = ${COMPANY}::UUID AND je.status = 'posted'
        AND je.reversal_of_id IS NOT NULL
        AND je.entry_date = ${TODAY}::date
        AND NOT EXISTS (SELECT 1 FROM customer_invoices d
                        WHERE d.company_id = ${COMPANY}::UUID AND d.gl_journal_entry_id = je.id)
    `) as { n: number }[];
    expect(chain[0]!.n).toBe(6);

    const cash = await getUnappliedControlCash(COMPANY, 'ar', TODAY, [receivable]);
    expect(cash.withoutPaymentRecord.map((i) => i.id)).toEqual([orphanEntry]);
    expect(cash.total).toBeCloseTo(ORPHAN, 2);
  });

  it('mid-chain, with the document still deleted, exactly one leg is reported', async () => {
    await inTx(() => softDelete(COMPANY, 'customer_invoice', invoice, USER));

    // R7 is recorded in `soft_delete_journal_reversals`, so the query excludes
    // it by that row and the six restored legs pair off. The reconciler is back
    // to the bare journal alone — the delete has moved the control account and
    // the dated presence predicate has taken the document off the sub-ledger
    // side with it, so there is nothing to reconcile.
    const cash = await getUnappliedControlCash(COMPANY, 'ar', TODAY, [receivable]);
    expect(cash.withoutPaymentRecord.map((i) => i.id)).toEqual([orphanEntry]);
    expect(cash.total).toBeCloseTo(ORPHAN, 2);

    await inTx(() => undoDelete(COMPANY, 'customer_invoice', invoice, USER));
  });
});
