import {beforeAll,afterAll,expect,it} from 'vitest';
import {arCiFixture} from './arCiFixture';
import {createCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentService';
import {createCreditNote} from '@/modules/accounting/services/ar/creditNoteService';
import {approveCreditNote} from '@/modules/accounting/services/ar/creditNoteApproveService';
import {applyCreditNoteToInvoice} from '@/modules/accounting/services/ar/creditNoteCancelService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
let f:Awaited<ReturnType<typeof arCiFixture>>;
beforeAll(async()=>{f=await arCiFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('another real draft reserves the115 invoice balance and second draft cannot overallocate',async()=>{
 const id=await f.invoice();await f.actor(()=>approveCustomerInvoice(f.f.companyA,id,f.f.u1.id));
 const input={clientId:f.customer,paymentDate:'2026-07-05',totalAmount:115,paymentMethod:'eft' as const,allocations:[{invoiceId:id,amount:115}]};
 const first=await f.actor(()=>createCustomerPayment(f.f.companyA,input,f.f.u1.id));expect(first.status).toBe('draft');const before=await f.state();
 await expect(f.actor(()=>createCustomerPayment(f.f.companyA,input,f.f.u1.id))).rejects.toThrow(/pending|draft|exceeds/);expect(await f.state()).toEqual(before);
 expect((await f.pool.query('SELECT amount_allocated::text FROM customer_payment_allocations WHERE payment_id=$1',[first.id])).rows).toEqual([{amount_allocated:'115.00'}]);
});
it('approved linked note applies115 once to1150 invoice and repeated apply leaves balances unchanged',async()=>{
 const id=await f.invoice(1000);await f.actor(()=>approveCustomerInvoice(f.f.companyA,id,f.f.u1.id));
 const note=await f.actor(()=>createCreditNote(f.f.companyA,{type:'customer',clientId:f.customer,customerInvoiceId:id,creditDate:'2026-07-05',subtotal:100},f.f.u1.id));
 await f.actor(()=>approveCreditNote(f.f.companyA,note.id,f.f.u1.id));
 expect((await f.pool.query('SELECT status FROM credit_notes WHERE company_id=$1 AND id=$2',[f.f.companyA,note.id])).rows[0].status).toBe('applied');
 expect((await f.pool.query('SELECT total_amount::text,amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0]).toEqual({total_amount:'1150.00',amount_paid:'115.00'});
 const before=await f.state();await expect(f.actor(()=>applyCreditNoteToInvoice(f.f.companyA,note.id,id,f.f.u1.id))).rejects.toThrow(/approved|applied/);expect(await f.state()).toEqual(before);
});
