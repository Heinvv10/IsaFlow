import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withBank39MissingPayment} from './bank39MissingPayment';
import {bank39Fixture} from './bank39Fixture';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {confirmReceiptMatch} from '@/modules/accounting/services/ar/receiptMatchConfirmService';
// PDF storage is outside this financial assertion scope; all authority, approval and monetary services are real.
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>{throw new Error('Synthetic PDF storage excluded from BANK39 proof');}}));
let b:Awaited<ReturnType<typeof bank39Fixture>>;
beforeAll(async()=>{
 b=await bank39Fixture();
 for(const [type,role] of [['revenue','default_revenue'],['liability','vat_output']])await b.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,left($1::uuid::text,20),$3,$4,$3,'credit',true,true,3)",[randomUUID(),b.f.companyA,role,type]);
});afterAll(async()=>{await b?.close();});
async function preparedReceipt(){
 const invoice=randomUUID(),tx=await b.source('1000');
 await b.pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,total_amount,currency_code,exchange_rate,functional_total,created_by) VALUES($1,$2,$3,$3,$1::uuid::text,'2026-03-01',1000,1000,'ZAR',1,1000,$4)",[invoice,b.f.companyA,b.customer,b.f.u1.id]);
 await b.pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'BANK39 service',1,1000,1000,0)",[invoice]);
 await b.actor(()=>approveCustomerInvoice(b.f.companyA,invoice,b.f.u1.id));
 const p=await b.prepare({version:1,kind:'customer',bankTransactionId:tx,description:'Matched customer receipt',partyId:b.customer,applications:[{invoiceId:invoice,amount:'600'}]});
 const postingOpts={intentId:p.intentId,approvalId:p.approvalId,postingAgent:'mcp:match_receipt:v1'};
 const run=()=>confirmReceiptMatch(b.f.companyA,{bankTxId:tx,userId:b.f.u1.id,allocations:[{invoiceId:invoice,amount:600}],postingOpts});
 return{invoice,tx,p,run};
}
it('actual confirmation posts one full-line journal and one owned child with exact selected application and remainder',async()=>{
 const r=await preparedReceipt(),result=await b.actor(r.run);
 expect(result).toMatchObject({receiptAmount:1000,allocatedTotal:600,unappliedRemainder:400,customerId:b.customer,paymentStatus:'confirmed'});
 const lines=await b.lines(result.journalEntryId);expect(lines).toHaveLength(2);expect(lines.reduce((sum,l)=>sum+Number(l.debit),0)).toBe(1000);
 expect((await b.pool.query('SELECT id,total_amount::text,gl_journal_entry_id FROM customer_payments WHERE company_id=$1 AND gl_journal_entry_id=$2',[b.f.companyA,result.journalEntryId])).rows).toEqual([{id:result.customerPaymentId,total_amount:'1000.00',gl_journal_entry_id:result.journalEntryId}]);
 expect((await b.pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[b.f.companyA,r.invoice])).rows[0].amount_paid).toBe('600.00');
 expect((await b.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[b.f.companyA,r.tx])).rows).toHaveLength(1);
});
it('foreign current tenant cannot confirm the owned receipt or create a child',async()=>{
 const r=await preparedReceipt();await expect(b.actor(r.run,'u3')).rejects.toThrow(/not found|company|permission/i);
 expect((await b.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[b.f.companyA,r.tx])).rows).toEqual([]);
});
it('outer failure after real confirmation rolls back journal, child, application and approval consumption',async()=>{
 const r=await preparedReceipt();await expect(b.actor(async()=>{await r.run();throw new Error('BANK39 receipt rollback');})).rejects.toThrow('BANK39 receipt rollback');
 expect((await b.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[b.f.companyA,r.tx])).rows).toEqual([]);
 expect((await b.pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[b.f.companyA,r.invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await b.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[b.f.companyA,r.p.approvalId])).rows[0].status).toBe('approved');
});

it('a real missing child INSERT aborts confirmation and unwinds journal and approval',async()=>{
 const r=await preparedReceipt();
 await expect(withBank39MissingPayment(b.pool,b.f,r.run)).rejects.toThrow('Allocation payment insert failed');
 expect((await b.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[b.f.companyA,r.tx])).rows).toEqual([]);
 expect((await b.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[b.f.companyA,r.p.approvalId])).rows[0].status).toBe('approved');
 expect((await b.pool.query("SELECT oid FROM pg_trigger WHERE tgname='bank39_drop_payment'")).rows).toEqual([]);
});
it('failure-injection helper rolls back its DDL even on unexpected callback success',async()=>{
 expect(await withBank39MissingPayment(b.pool,b.f,async()=>42)).toBe(42);
 expect((await b.pool.query("SELECT oid FROM pg_trigger WHERE tgname='bank39_drop_payment'")).rows).toEqual([]);
});
