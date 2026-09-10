// tests/integration/customer-ownership-fence.int.test.ts
//
// R-067. `customer_invoices.client_id` has no foreign key at all and
// `customer_id`'s FK is tenant-agnostic; the RLS WITH CHECK on the table only
// tests the INVOICE's own company_id. So a `clientId` taken from a request body
// and written into both columns was never checked against `customers` —
// company A could book an invoice against company B's customer, and the
// customer-portal PDF route (which runs as `postgres`, outside RLS) would then
// print B's name, VAT number and billing address on A's tax invoice.
//
// These run against a real database because the hole IS the database's shape:
// a mocked `sql` cannot show that the FK permits the row. The refusal case
// asserts by outcome — zero rows in `customer_invoices` afterwards — rather
// than by the message, and the own-tenant case asserts the invoice is still
// created, because a guard has to fail in both directions.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { createQuote, updateQuote } from '@/modules/accounting/services/ar/quoteService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY_A = '00000000-0000-0000-0000-0000000f0671';
const COMPANY_B = '00000000-0000-0000-0000-0000000f0672';
const CUSTOMER_A = '00000000-0000-0000-0000-0000000f0673';
const CUSTOMER_B = '00000000-0000-0000-0000-0000000f0674';
const USER = '00000000-0000-0000-0000-0000000f0675';
const BANK_ACCT = '00000000-0000-0000-0000-0000000f0676';
const AR_ACCT = '00000000-0000-0000-0000-0000000f0677';
const BANK_TX = '00000000-0000-0000-0000-0000000f0678';

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('R-067 — an invoice cannot be booked against another company customer', () => {
  let admin: Pool;

  function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
    return als.run({ client: c, userId: USER, companyId: COMPANY_A, claims: {} } as never, fn);
  }

  /** A request transaction of exactly the shape `withAuth` opens. */
  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    const c = await admin.connect();
    await c.query('BEGIN');
    try {
      const out = await run(c, fn);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    for (const [id, name] of [[COMPANY_A, 'Fence Co A'], [COMPANY_B, 'Fence Co B']] as const) {
      await admin.query(
        `INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)
         ON CONFLICT (id) DO NOTHING`,
        [id, name],
      );
    }
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Customer A')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_A, COMPANY_A],
    );
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Customer B')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_B, COMPANY_B],
    );

    // The bank-allocation case posts a real journal and inserts a real
    // customer_payments row, so that removing the fence writes the cross-tenant
    // row rather than merely failing somewhere else.
    await admin.query(
      `INSERT INTO users (id, email, account_type) VALUES ($1, $2, 'direct')
       ON CONFLICT (id) DO NOTHING`,
      [USER, `fence-${USER}@isaflow.test`],
    );
    for (const [id, code, name, type, subtype, normal] of [
      [BANK_ACCT, '1000', 'Fence Bank', 'asset', 'bank', 'debit'],
      [AR_ACCT, '1100', 'Fence AR', 'asset', 'receivable', 'debit'],
    ] as const) {
      await admin.query(
        `INSERT INTO gl_accounts
           (id, company_id, account_code, account_name, account_type, account_subtype,
            normal_balance, is_active, is_system_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, true)
         ON CONFLICT (id) DO NOTHING`,
        [id, COMPANY_A, code, name, type, subtype, normal],
      );
    }
    await admin.query(
      `INSERT INTO bank_transactions
         (id, company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 115, 'Fence receipt', 'imported')
       ON CONFLICT (id) DO NOTHING`,
      [BANK_TX, COMPANY_A, BANK_ACCT],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it("refuses company B's customer and writes nothing", async () => {
    await expect(
      createDraftCustomerInvoice(COMPANY_A, USER, {
        clientId: CUSTOMER_B,
        items: [{ description: 'Cross-tenant', unitPrice: 1000, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(CustomerNotInCompanyError);

    const rows = await admin.query(
      `SELECT id FROM customer_invoices
        WHERE company_id = $1 AND (client_id = $2 OR customer_id = $2)`,
      [COMPANY_A, CUSTOMER_B],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("still creates the invoice for company A's own customer", async () => {
    const { id, invoiceNumber } = await createDraftCustomerInvoice(COMPANY_A, USER, {
      clientId: CUSTOMER_A,
      items: [{ description: 'Own tenant', unitPrice: 1000, quantity: 1 }],
    });
    expect(invoiceNumber).toBeTruthy();

    const rows = await admin.query(
      `SELECT client_id, customer_id, total_amount FROM customer_invoices
        WHERE id = $1 AND company_id = $2`,
      [id, COMPANY_A],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].client_id).toBe(CUSTOMER_A);
    expect(rows.rows[0].customer_id).toBe(CUSTOMER_A);
  });

  it('refuses a non-UUID inside a real request transaction, which stays usable', async () => {
    // INSIDE `als.run` on a client that has issued BEGIN — the shape `withAuth`
    // creates. Without it `withSavepoint` takes its `if (!ctxClient) return fn()`
    // degrade path (lib/neon.ts:434-438), each bare `sql` opens its own
    // connection, there is nothing to poison, and the SAVEPOINT this case exists
    // to pin is never executed. In that shape the whole case passes with the
    // savepoint removed.
    await inTx(async () => {
      await expect(
        createDraftCustomerInvoice(COMPANY_A, USER, {
          clientId: 'not-a-uuid',
          items: [{ description: 'Malformed', unitPrice: 10, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(CustomerNotInCompanyError);

      // The SAME transaction must still be usable: a 22P02 that escaped the
      // savepoint leaves it aborted and every later statement raises 25P02.
      const after = await createDraftCustomerInvoice(COMPANY_A, USER, {
        clientId: CUSTOMER_A,
        items: [{ description: 'After malformed', unitPrice: 10, quantity: 1 }],
      });
      expect(after.id).toBeTruthy();
    });
  });

  it('still edits a draft quote whose own customer has been soft-deleted', async () => {
    // The fence asks about the TENANT, not about `deleted_at`. Four of its call
    // sites are updates or an execute that take the id from a row the company
    // already owns, and softDeleteService.ts:69-73 soft-deletes a customer with
    // no check for open documents. With `deleted_at IS NULL` in the fence this
    // update raised CustomerNotInCompanyError — a save that worked before the
    // fence existed, refused for a reason that closes no cross-tenant exposure.
    const quote = await createQuote(COMPANY_A, {
      clientId: CUSTOMER_A, customerName: 'Customer A',
      lines: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
    }, USER);

    await admin.query('UPDATE customers SET deleted_at = NOW() WHERE id = $1', [CUSTOMER_A]);
    try {
      const updated = await updateQuote(COMPANY_A, quote.id, {
        clientId: CUSTOMER_A, customerName: 'Customer A',
        lines: [{ description: 'Work, revised', quantity: 2, unitPrice: 100 }],
      });
      expect(updated?.total).toBeCloseTo(230, 2);
    } finally {
      await admin.query('UPDATE customers SET deleted_at = NULL WHERE id = $1', [CUSTOMER_A]);
    }

    // …and the tenant question is still answered: company B's customer is
    // refused on the same update path.
    await expect(
      updateQuote(COMPANY_A, quote.id, {
        clientId: CUSTOMER_B, customerName: 'Customer B',
        lines: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
      }),
    ).rejects.toBeInstanceOf(CustomerNotInCompanyError);
  });

  it("refuses a bank receipt allocated to company B's customer, posting nothing", async () => {
    // `entityId` reaches `allocateTransaction` straight from the request body
    // (bank-transactions-action.ts:40 validates its UUID shape only, :118 passes
    // it through) and is written into `customer_payments.client_id`. Before the
    // fence this call succeeded: the journal posted and the payment row carried
    // company B's client_id under company A's company_id.
    await inTx(async () => {
      await expect(
        allocateTransaction(
          COMPANY_A, BANK_TX, null, USER, 'Receipt', 'customer', CUSTOMER_B,
        ),
      ).rejects.toBeInstanceOf(CustomerNotInCompanyError);
    });

    const payments = await admin.query(
      'SELECT id FROM customer_payments WHERE company_id = $1',
      [COMPANY_A],
    );
    expect(payments.rowCount).toBe(0);
    const journals = await admin.query(
      'SELECT id FROM gl_journal_entries WHERE company_id = $1',
      [COMPANY_A],
    );
    expect(journals.rowCount).toBe(0);
    const tx = await admin.query('SELECT status FROM bank_transactions WHERE id = $1', [BANK_TX]);
    expect(tx.rows[0].status).toBe('imported');
  });

  it("allocates the same receipt to company A's own customer", async () => {
    const { journalEntryId } = await inTx(() => allocateTransaction(
      COMPANY_A, BANK_TX, null, USER, 'Receipt', 'customer', CUSTOMER_A,
    ));
    expect(journalEntryId).toBeTruthy();

    const payments = await admin.query(
      'SELECT client_id, total_amount FROM customer_payments WHERE company_id = $1',
      [COMPANY_A],
    );
    expect(payments.rowCount).toBe(1);
    expect(payments.rows[0].client_id).toBe(CUSTOMER_A);
  });
});


async function cleanup(admin: Pool): Promise<void> {
  const companies = [[COMPANY_A, COMPANY_B]];
  await admin.query('DELETE FROM customer_payments WHERE company_id = ANY($1::UUID[])', companies);
  await admin.query(
    `DELETE FROM customer_quote_lines WHERE quote_id IN (
       SELECT id FROM customer_quotes WHERE company_id = ANY($1::UUID[]))`,
    companies,
  );
  await admin.query('DELETE FROM customer_quotes WHERE company_id = ANY($1::UUID[])', companies);
  await admin.query('DELETE FROM bank_transactions WHERE company_id = ANY($1::UUID[])', companies);
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1::UUID[])', companies);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1::UUID[])', companies);
  await admin.query(
    `DELETE FROM gl_account_balances WHERE gl_account_id IN (
       SELECT id FROM gl_accounts WHERE company_id = ANY($1::UUID[]))`,
    companies,
  );
  await admin.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::UUID[])', companies);
  await admin.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1::UUID[])', companies);
  await admin.query(
    `DELETE FROM customer_invoice_items WHERE invoice_id IN (
       SELECT id FROM customer_invoices WHERE company_id = ANY($1::UUID[]))`,
    [[COMPANY_A, COMPANY_B]],
  );
  await admin.query('DELETE FROM customer_invoices WHERE company_id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM customers WHERE company_id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM users WHERE id = $1', [USER]);
}
