// tests/integration/invoice-list-filters.int.test.ts
//
// Customer/supplier + invoice-date filters on the AR and AP invoice lists.
//
// The risk in this feature is tenancy: a customer or supplier id arrives from
// the query string, so it must narrow within the caller's company and never
// reach another company's rows. Two companies are seeded; each test asks as
// company A and asserts on the rows that come back — never on the SQL.
//
// Dates sit on month boundaries (31 May, 1 Jun, 30 Jun, 1 Jul) so an
// off-by-one on either inclusive bound changes a count.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  listCustomerInvoices,
  exportCustomerInvoices,
} from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { getSupplierInvoices } from '@/modules/accounting/services/ap/supplierInvoiceQueryService';
import { monthRange } from '@/components/accounting/invoicePeriod';

const DATABASE_URL = process.env.DATABASE_URL;

const CO_A = '00000000-0000-0000-0000-0000000f1a01';
const CO_B = '00000000-0000-0000-0000-0000000f1b01';
const CUST_A1 = '00000000-0000-0000-0000-0000000f1a11';
const CUST_A2 = '00000000-0000-0000-0000-0000000f1a12';
const CUST_B1 = '00000000-0000-0000-0000-0000000f1b11';
const SUPP_A1 = '00000000-0000-0000-0000-0000000f1a21';
const SUPP_B1 = '00000000-0000-0000-0000-0000000f1b21';

const JUNE = monthRange('2026-06')!;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('invoice list filters: customer/supplier + invoice date', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Filter Co A', true), ($2, 'Filter Co B', true)
       ON CONFLICT (id) DO NOTHING`,
      [CO_A, CO_B],
    );
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES
         ($1, $4, 'Filter Customer A1'), ($2, $4, 'Filter Customer A2'), ($3, $5, 'Filter Customer B1')
       ON CONFLICT (id) DO NOTHING`,
      [CUST_A1, CUST_A2, CUST_B1, CO_A, CO_B],
    );
    await admin.query(
      `INSERT INTO suppliers (id, company_id, name) VALUES ($1, $3, 'Filter Supplier A1'), ($2, $4, 'Filter Supplier B1')
       ON CONFLICT (id) DO NOTHING`,
      [SUPP_A1, SUPP_B1, CO_A, CO_B],
    );

    // Customer A1 straddles June on both sides; A2 is mid-June; B1 belongs to
    // company B. FLT-AR-5 sets customer_id only (client_id NULL), so the
    // customer filter must go through COALESCE(client_id, customer_id).
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
       VALUES
         ($1, $2, $2, 'FLT-AR-1', '2026-05-31', '2026-06-30', 'approved', 100, 0, $6),
         ($1, $2, $2, 'FLT-AR-2', '2026-06-01', '2026-07-01', 'approved', 200, 0, $6),
         ($1, $2, $2, 'FLT-AR-3', '2026-06-30', '2026-07-30', 'approved', 300, 0, $6),
         ($1, $2, $2, 'FLT-AR-4', '2026-07-01', '2026-07-31', 'approved', 400, 0, $6),
         ($1, NULL, $3, 'FLT-AR-5', '2026-06-15', '2026-07-15', 'approved', 500, 0, $6),
         ($4, $5, $5, 'FLT-AR-6', '2026-06-15', '2026-07-15', 'approved', 600, 0, $6)`,
      [CO_A, CUST_A1, CUST_A2, CO_B, CUST_B1, CO_A],
    );

    await admin.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
       VALUES
         ($1, $2, 'FLT-AP-1', '2026-05-31', '2026-06-30', 'approved', 100, 0, $5),
         ($1, $2, 'FLT-AP-2', '2026-06-01', '2026-07-01', 'approved', 200, 0, $5),
         ($1, $2, 'FLT-AP-3', '2026-06-30', '2026-07-30', 'approved', 300, 0, $5),
         ($1, $2, 'FLT-AP-4', '2026-07-01', '2026-07-31', 'approved', 400, 0, $5),
         ($3, $4, 'FLT-AP-5', '2026-06-15', '2026-07-15', 'approved', 500, 0, $5)`,
      [CO_A, SUPP_A1, CO_B, SUPP_B1, CO_A],
    );
  });

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  const arNumbers = async (companyId: string, f: Parameters<typeof listCustomerInvoices>[1]) => {
    const { invoices, total } = await listCustomerInvoices(companyId, { search: 'FLT-AR-', limit: 100, ...f });
    const numbers = invoices.map(i => String(i.invoice_number)).sort();
    expect(total).toBe(numbers.length);
    return numbers;
  };

  const apNumbers = async (companyId: string, f: Parameters<typeof getSupplierInvoices>[1]) => {
    const { invoices, total } = await getSupplierInvoices(companyId, { search: 'FLT-AP-', limit: 100, ...f });
    const numbers = invoices.map(i => i.invoiceNumber).sort();
    expect(total).toBe(numbers.length);
    return numbers;
  };

  describe('customer invoices', () => {
    it('without the new filters returns every company-A invoice and none of B', async () => {
      expect(await arNumbers(CO_A, {})).toEqual(['FLT-AR-1', 'FLT-AR-2', 'FLT-AR-3', 'FLT-AR-4', 'FLT-AR-5']);
    });

    it('filters to one customer, including a customer_id-only invoice', async () => {
      expect(await arNumbers(CO_A, { clientId: CUST_A1 })).toEqual(['FLT-AR-1', 'FLT-AR-2', 'FLT-AR-3', 'FLT-AR-4']);
      expect(await arNumbers(CO_A, { clientId: CUST_A2 })).toEqual(['FLT-AR-5']);
    });

    it('dateFrom is inclusive', async () => {
      expect(await arNumbers(CO_A, { dateFrom: '2026-06-01' })).toEqual(['FLT-AR-2', 'FLT-AR-3', 'FLT-AR-4', 'FLT-AR-5']);
    });

    it('dateTo is inclusive', async () => {
      expect(await arNumbers(CO_A, { dateTo: '2026-06-30' })).toEqual(['FLT-AR-1', 'FLT-AR-2', 'FLT-AR-3', 'FLT-AR-5']);
    });

    it('a month covers the whole local month and nothing either side', async () => {
      expect(JUNE).toEqual({ from: '2026-06-01', to: '2026-06-30' });
      expect(await arNumbers(CO_A, { dateFrom: JUNE.from, dateTo: JUNE.to })).toEqual(['FLT-AR-2', 'FLT-AR-3', 'FLT-AR-5']);
    });

    it('combines customer, month and status', async () => {
      expect(await arNumbers(CO_A, { clientId: CUST_A1, dateFrom: JUNE.from, dateTo: JUNE.to })).toEqual(['FLT-AR-2', 'FLT-AR-3']);
      expect(await arNumbers(CO_A, { clientId: CUST_A1, dateFrom: JUNE.from, dateTo: JUNE.to, status: ['paid'] })).toEqual([]);
    });

    it("another company's customer id returns zero rows, not that company's rows", async () => {
      expect(await arNumbers(CO_A, { clientId: CUST_B1 })).toEqual([]);
      expect(await arNumbers(CO_A, { clientId: CUST_B1, dateFrom: JUNE.from, dateTo: JUNE.to })).toEqual([]);
      // Control: the same id does select B's invoice when B asks.
      expect(await arNumbers(CO_B, { clientId: CUST_B1 })).toEqual(['FLT-AR-6']);
    });

    it('export applies the same filters and tenant scope as the list', async () => {
      const rows = await exportCustomerInvoices(CO_A, { search: 'FLT-AR-', clientId: CUST_A1, dateFrom: JUNE.from, dateTo: JUNE.to });
      expect(rows.map(r => String(r.invoice_number)).sort()).toEqual(['FLT-AR-2', 'FLT-AR-3']);
      expect(await exportCustomerInvoices(CO_A, { search: 'FLT-AR-', clientId: CUST_B1 })).toEqual([]);
    });
  });

  describe('supplier invoices', () => {
    it('filters to one supplier and a month, inclusive at both ends', async () => {
      expect(await apNumbers(CO_A, { supplierId: SUPP_A1, fromDate: JUNE.from, toDate: JUNE.to })).toEqual(['FLT-AP-2', 'FLT-AP-3']);
    });

    it("another company's supplier id returns zero rows", async () => {
      expect(await apNumbers(CO_A, { supplierId: SUPP_B1 })).toEqual([]);
      expect(await apNumbers(CO_B, { supplierId: SUPP_B1 })).toEqual(['FLT-AP-5']);
    });
  });
});

async function cleanup(admin: Pool): Promise<void> {
  await admin.query(`DELETE FROM customer_invoices WHERE company_id IN ($1, $2)`, [CO_A, CO_B]);
  await admin.query(`DELETE FROM supplier_invoices WHERE company_id IN ($1, $2)`, [CO_A, CO_B]);
  await admin.query(`DELETE FROM customers WHERE company_id IN ($1, $2)`, [CO_A, CO_B]);
  await admin.query(`DELETE FROM suppliers WHERE company_id IN ($1, $2)`, [CO_A, CO_B]);
  await admin.query(`DELETE FROM companies WHERE id IN ($1, $2)`, [CO_A, CO_B]);
}
