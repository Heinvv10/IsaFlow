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
 try {
  await client.query('BEGIN');
  await als.run({client,companyId,userId:'fixture',claims:{}},async()=>{
   await sql`CREATE TEMP TABLE IF NOT EXISTS suppliers (id UUID, company_id UUID, name TEXT) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS supplier_invoices (id UUID, company_id UUID, supplier_id UUID, invoice_date DATE, due_date DATE, total_amount NUMERIC, amount_paid NUMERIC, status TEXT) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS supplier_payments (id UUID, company_id UUID, supplier_id UUID, payment_date DATE, total_amount NUMERIC, status TEXT) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS payment_allocations (payment_id UUID, invoice_id UUID, amount_allocated NUMERIC) ON COMMIT DROP`;
   await sql`CREATE TEMP TABLE IF NOT EXISTS credit_notes (company_id UUID, supplier_id UUID, supplier_invoice_id UUID, credit_date DATE, cancelled_at TIMESTAMPTZ, total_amount NUMERIC, applied_amount NUMERIC, status TEXT, type TEXT) ON COMMIT DROP`;
   await sql`INSERT INTO suppliers VALUES (${supplierId},${companyId},'Future invoice supplier')`;
   await sql`INSERT INTO supplier_invoices VALUES (${invoiceId},${companyId},${supplierId},'2026-09-01','2026-09-30',200,115,'partially_paid')`;
   await sql`INSERT INTO supplier_payments VALUES (${paymentId},${companyId},${supplierId},'2026-08-15',100,'reconciled')`;
   await sql`INSERT INTO payment_allocations VALUES (${paymentId},${invoiceId},100)`;
   await sql`INSERT INTO credit_notes VALUES (${companyId},${supplierId},${invoiceId},'2026-08-20',NULL,40,15,'applied','supplier')`;
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
