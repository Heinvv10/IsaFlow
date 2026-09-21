import { expect, it } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getSupplierStatementBalances } from '@/modules/accounting/services/ap/supplierStatementBalancesService';

// Temporary tables shadow the application tables for this connection only.
// Rollback removes all fixtures, including on assertion failure.
it('retains funds applied to future invoices as on-account credit until the invoice cutoff', async () => {
 const client=await getPoolForTests().connect();
 const companyId='11111111-1111-4111-9111-111111111111';
 const supplierId='22222222-2222-4222-9222-222222222222';
 const invoiceId='33333333-3333-4333-9333-333333333333';
 const paymentId='44444444-4444-4444-9444-444444444444';
 const createdBy='55555555-5555-4555-9555-555555555555';
 try {
  await client.query('BEGIN');
  await als.run({client,companyId,userId:'fixture',claims:{}},async()=>{
   // LIKE ... INCLUDING ALL mirrors the real table shape (columns, defaults,
   // generated columns) so a column the service starts reading — deleted_at,
   // gl_journal_entry_id, whatever's next — is already present here and this
   // fixture can't drift out from under the service again (R-076).
   await sql`CREATE TEMP TABLE IF NOT EXISTS suppliers (LIKE suppliers INCLUDING ALL) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS supplier_invoices (LIKE supplier_invoices INCLUDING ALL) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS supplier_payments (LIKE supplier_payments INCLUDING ALL) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS payment_allocations (LIKE payment_allocations INCLUDING ALL) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS credit_notes (LIKE credit_notes INCLUDING ALL) ON COMMIT DROP`;
   await sql`INSERT INTO suppliers (id,company_id,name) VALUES (${supplierId},${companyId},'Future invoice supplier')`;
   await sql`INSERT INTO supplier_invoices (id,company_id,supplier_id,invoice_number,invoice_date,due_date,total_amount,amount_paid,status,created_by)
     VALUES (${invoiceId},${companyId},${supplierId},'INV-1','2026-09-01','2026-09-30',200,115,'partially_paid',${createdBy})`;
   await sql`INSERT INTO supplier_payments (id,company_id,supplier_id,payment_date,total_amount,status,created_by)
     VALUES (${paymentId},${companyId},${supplierId},'2026-08-15',100,'reconciled',${createdBy})`;
   await sql`INSERT INTO payment_allocations (payment_id,invoice_id,amount_allocated) VALUES (${paymentId},${invoiceId},100)`;
   await sql`INSERT INTO credit_notes (company_id,supplier_id,supplier_invoice_id,credit_date,cancelled_at,total_amount,applied_amount,status,type,created_by)
     VALUES (${companyId},${supplierId},${invoiceId},'2026-08-20',NULL,40,15,'applied','supplier',${createdBy})`;
   expect(await getSupplierStatementBalances(companyId,'2026-08-31')).toEqual([
    expect.objectContaining({entityId:supplierId,total:0,onAccount:140,netBalance:-140}),
   ]);
   expect(await getSupplierStatementBalances(companyId,'2026-09-09')).toEqual([
    expect.objectContaining({entityId:supplierId,total:85,onAccount:25,netBalance:60}),
   ]);
  });
 } finally {
  await client.query('ROLLBACK');
  client.release();
 }
});
