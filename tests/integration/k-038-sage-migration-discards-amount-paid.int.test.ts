/**
 * K-038 RED — the Sage migration mapper computes amountPaid (Total - AmountDue)
 * in mapSageARInvoices/mapSageAPInvoices
 * (src/modules/accounting/services/core/sageAutoImportService.ts:246,262) but
 * commitARInvoice (src/modules/admin/services/sageMigrationCommitService.ts:105-119)
 * never writes it, so a part-paid invoice imports as fully outstanding.
 *
 * postCustomerInvoiceToGL is mocked — GL posting is not part of the claim and
 * would need system accounts + an open fiscal period the claim does not touch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', () => ({
  postCustomerInvoiceToGL: vi.fn(async () => undefined),
}));

const { commitARInvoice } = await import('@/modules/admin/services/sageMigrationCommitService');
const { mapSageARInvoices } = await import('@/modules/accounting/services/core/sageAutoImportService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const invoiceNumber = `K038-${companyId.slice(0, 8)}`;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'K-038 fixture']);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@k038.test.local`],
  );
  await pool.query(
    'INSERT INTO customers(company_id,name,is_active) VALUES($1,$2,TRUE)',
    [companyId, 'K-038 Customer'],
  );
});

afterAll(async () => {
  await pool.query(
    'DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)',
    [companyId],
  );
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM customers WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
  await pool.end();
});

describe('K-038 Sage AR invoice import preserves the source payment balance', () => {
  it('carries Sage AmountDue through to customer_invoices.amount_paid', async () => {
    // Sage: R1,150 invoice with R650 already paid, R500 still due.
    const [mapped] = mapSageARInvoices([{
      ID: 991, CustomerId: 1, Customer: { Name: 'K-038 Customer' },
      DocumentNumber: invoiceNumber, Reference: 'K-038 part-paid',
      Date: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00',
      Exclusive: 1000, Tax: 150, Total: 1150, AmountDue: 500, Status: 'PartPaid',
    }]);

    // The mapper does carry the payment through.
    expect(mapped!.amountPaid).toBe(650);

    const { invoiceId, created } = await commitARInvoice(companyId, userId, mapped as never);
    expect(created).toBe(true);

    const { rows } = await pool.query(
      'SELECT total_amount, amount_paid, balance, status FROM customer_invoices WHERE id=$1',
      [invoiceId],
    );
    const row = rows[0]!;
    expect(Number(row.total_amount)).toBe(1150);

    // RED: the commit drops amountPaid, so the imported invoice shows the whole
    // R1,150 outstanding instead of the R500 Sage says is still due.
    expect(Number(row.amount_paid)).toBe(650);
    expect(Number(row.balance)).toBe(500);
  });
});
