/**
 * K-053 round 5 (LOW-3) — the parity predicate's PRECONDITION, pinned.
 *
 * `documentInLedgerAsAtFragment` decides presence by the parity of the chain
 * entries dated on or before the as-at date. That equals the chain's net
 * position only when those entries form a PREFIX of the chain — i.e. only when
 * no reversal is ever dated BEFORE the entry it reverses.
 *
 * `resolveReversalDate` is what makes that true: it returns the target's own
 * date when that period is open and TODAY when it is not, and it REFUSES an
 * explicit `reversalDate` earlier than the entry being corrected. The first
 * test below is that refusal — the load-bearing guard. The second hand-builds
 * the illegal chain directly in SQL, which no code path can produce, and pins
 * what the predicate would answer if a future change to `resolveReversalDate`
 * ever allowed one: the sub-ledger side says the document is present at a date
 * where the control account has already been credited. That is the failure
 * mode, recorded so the coupling is visible rather than silent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {
  reverseJournalEntry,
  ReversalPeriodError,
} from '@/modules/accounting/services/gl/journalEntryPostingService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053ORDER-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const DOC_DATE = shift(-30);
const BEFORE_DOC = shift(-40);
const PERIOD_END = shift(400);
const OUTSIDE_EVERY_PERIOD = shift(500);

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;

const receivable = randomUUID();
const revenue = randomUUID();
const vatOutput = randomUUID();

let customer: string;
let invoice: string;
let originalEntry: string;

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

async function controlBalance(asAt: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
    FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${COMPANY}::UUID AND l.gl_account_id = ${receivable}::UUID
      AND e.status = 'posted' AND e.entry_date <= ${asAt}::date
  `) as { net: string | number }[];
  return Number(rows[0]!.net);
}

/** The predicate itself, evaluated against the invoice row at one as-at date. */
async function presentAsAt(asAt: string): Promise<boolean | null> {
  const rows = (await sql`
    SELECT ${documentInLedgerAsAtFragment('ci', asAt, COMPANY)} AS present
    FROM customer_invoices ci
    WHERE ci.id = ${invoice}::UUID AND ci.company_id = ${COMPANY}::UUID
  `) as { present: boolean | null }[];
  return rows[0]!.present;
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

describeIfDb('K-053 the parity predicate assumes reversals are never back-dated', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053ORDER ' + TAG}, ${TAG})`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053ORDER ' + TAG}, 1, 2026, '2020-01-01', ${PERIOD_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');

    customer = ((await sql`INSERT INTO customers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    invoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR'}, ${DOC_DATE}::date,
        ${DOC_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await inTx(() => postCustomerInvoiceToGL(COMPANY, invoice, USER));
    originalEntry = ((await sql`
      SELECT gl_journal_entry_id AS id FROM customer_invoices
      WHERE id = ${invoice}::UUID AND company_id = ${COMPANY}::UUID
    `) as { id: string }[])[0]!.id;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${revenue}::UUID, ${vatOutput}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 120000);

  it('resolveReversalDate REFUSES a reversal dated before the entry it corrects', async () => {
    await expect(
      inTx(() => reverseJournalEntry(COMPANY, originalEntry, USER, { reversalDate: BEFORE_DOC })),
    ).rejects.toThrow(/before the entry it reverses/i);

    // Nothing was written by the refusal, so the chain is still length 1.
    const rows = (await sql`
      SELECT COUNT(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${COMPANY}::UUID AND reversal_of_id = ${originalEntry}::UUID
    `) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });

  it('an unusable target period is a TYPED refusal, not a plain Error', async () => {
    // The route decides 400-vs-500 on the class (see
    // tests/unit/services/core/softDeleteRouteErrorClass.test.ts), so these two
    // throws have to carry it. Both are raised BEFORE createJournalEntry
    // inserts anything, which is why nothing needs cleaning up after them.
    await expect(
      inTx(() => reverseJournalEntry(COMPANY, originalEntry, USER, { reversalDate: OUTSIDE_EVERY_PERIOD })),
    ).rejects.toBeInstanceOf(ReversalPeriodError);

    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${COMPANY}::UUID`;
    try {
      await expect(
        inTx(() => reverseJournalEntry(COMPANY, originalEntry, USER, { reversalDate: DOC_DATE })),
      ).rejects.toBeInstanceOf(ReversalPeriodError);
    } finally {
      await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${COMPANY}::UUID`;
    }
  });

  it('a hand-built back-dated chain is where parity and the GL part company', async () => {
    // Built by direct SQL because no code path can produce it. The reversal is
    // dated ten days BEFORE the invoice it reverses.
    const reversalId = randomUUID();
    await sql`
      INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
        status, source, reversal_of_id, created_by)
      VALUES (${reversalId}::UUID, ${COMPANY}::UUID, ${'JE-' + TAG}, ${BEFORE_DOC}::date,
        ${'Back-dated reversal ' + TAG}, 'posted', 'manual', ${originalEntry}::UUID, ${USER}::UUID)`;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${COMPANY}::UUID, ${reversalId}::UUID, ${receivable}::UUID, 0, ${GROSS}, ${'reversal'}),
             (${COMPANY}::UUID, ${reversalId}::UUID, ${revenue}::UUID, ${SUB}, 0, ${'reversal'}),
             (${COMPANY}::UUID, ${reversalId}::UUID, ${vatOutput}::UUID, ${VAT}, 0, ${'reversal'})`;
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW()
              WHERE id = ${originalEntry}::UUID AND company_id = ${COMPANY}::UUID`;
    await sql`UPDATE customer_invoices SET deleted_at = NOW()
              WHERE id = ${invoice}::UUID AND company_id = ${COMPANY}::UUID`;

    try {
      // As at the back-dated reversal's own date the GL is already NEGATIVE:
      // the credit has landed and the debit that created it has not.
      expect(await controlBalance(BEFORE_DOC)).toBeCloseTo(-GROSS, 2);
      // The predicate counts ONE entry <= that date, calls it odd, and answers
      // PRESENT — the opposite of what the GL says at that date. This is the
      // documented failure mode, and it exists because the entries <= as-at
      // are not a prefix of the chain. (Aging itself cannot show it here: its
      // own `invoice_date <= as-at` bound drops the invoice at a date before
      // it was raised, which is why the predicate is asserted directly.)
      expect(await presentAsAt(BEFORE_DOC)).toBe(true);

      // The chain is well-formed again once both entries are in range, so the
      // precondition is about ORDER, not about the walk itself: at the invoice
      // date both entries count, parity is even, and both sides say absent.
      expect(await controlBalance(DOC_DATE)).toBeCloseTo(0, 2);
      expect(await presentAsAt(DOC_DATE)).toBe(false);
      const later = (await getARAging(COMPANY, DOC_DATE)).find((b) => b.entityId === customer);
      expect(later?.total ?? 0).toBeCloseTo(0, 2);
    } finally {
      await sql`DELETE FROM gl_journal_lines WHERE journal_entry_id = ${reversalId}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE id = ${reversalId}::UUID`;
      await sql`UPDATE gl_journal_entries SET reversed_at = NULL
                WHERE id = ${originalEntry}::UUID AND company_id = ${COMPANY}::UUID`;
    }
  });
});
