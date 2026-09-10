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
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY_A = '00000000-0000-0000-0000-0000000f0671';
const COMPANY_B = '00000000-0000-0000-0000-0000000f0672';
const CUSTOMER_A = '00000000-0000-0000-0000-0000000f0673';
const CUSTOMER_B = '00000000-0000-0000-0000-0000000f0674';
const USER = '00000000-0000-0000-0000-0000000f0675';

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('R-067 — an invoice cannot be booked against another company customer', () => {
  let admin: Pool;

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

  it('refuses an id that is not a UUID without aborting the connection', async () => {
    await expect(
      createDraftCustomerInvoice(COMPANY_A, USER, {
        clientId: 'not-a-uuid',
        items: [{ description: 'Malformed', unitPrice: 10, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(CustomerNotInCompanyError);

    // The connection is still usable — a 22P02 that escaped would leave the
    // request transaction aborted and every later statement raising 25P02.
    const after = await createDraftCustomerInvoice(COMPANY_A, USER, {
      clientId: CUSTOMER_A,
      items: [{ description: 'After malformed', unitPrice: 10, quantity: 1 }],
    });
    expect(after.id).toBeTruthy();
  });
});

async function cleanup(admin: Pool): Promise<void> {
  await admin.query(
    `DELETE FROM customer_invoice_items WHERE invoice_id IN (
       SELECT id FROM customer_invoices WHERE company_id = ANY($1::UUID[]))`,
    [[COMPANY_A, COMPANY_B]],
  );
  await admin.query('DELETE FROM customer_invoices WHERE company_id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM customers WHERE company_id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [[COMPANY_A, COMPANY_B]]);
}
