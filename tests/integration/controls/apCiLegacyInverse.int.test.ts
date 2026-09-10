import {beforeAll,afterAll,it,expect} from 'vitest';
import {apCiWorkflowFixture} from './apCiWorkflowFixture';
import {createJournalEntry,postJournalEntry,reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
let f:Awaited<ReturnType<typeof apCiWorkflowFixture>>;
beforeAll(async()=>{f=await apCiWorkflowFixture();await f.pool.query("INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,'Legacy inverse independent policy','journal_entry','amount','any',0,'admin')",[f.f.companyA]);},30000);
afterAll(async()=>{if(f)await f.close();});
/** Legacy parent association is source setup; both original and inverse journal receipts are real. */
async function reversedManual(kind:'invoice'|'payment'){
 const lines=kind==='invoice'?[{glAccountId:f.accounts.default_expense,debit:100,credit:0},{glAccountId:f.accounts.vat_input,debit:15,credit:0},{glAccountId:f.accounts.payable,debit:0,credit:115}]
  :[{glAccountId:f.accounts.payable,debit:115,credit:0},{glAccountId:f.accounts.bank,debit:0,credit:115}];
 const journal=await f.actor(()=>createJournalEntry(f.f.companyA,{entryDate:'2026-09-09',description:'Actual legacy AP journal before cancellation',source:'manual',lines},f.f.u1.id));
 const postId=await f.approve({operation:'journal.post',entityType:'journal_entry',entityId:journal.id});await f.actor(()=>postJournalEntry(f.f.companyA,journal.id,f.f.u1.id,{approvalId:postId}));
 const reverseId=await f.approve({operation:'journal.reverse',entityType:'journal_entry',entityId:journal.id});await f.actor(()=>reverseJournalEntry(f.f.companyA,journal.id,f.f.u1.id,{approvalId:reverseId}));
 return journal.id;
}
it('independently cancels a still-approved legacy bill with an already reversed real journal without another inverse',async()=>{
 const invoice=await f.invoice(),journal=await reversedManual('invoice');
 await f.pool.query("UPDATE supplier_invoices SET status='approved',gl_journal_entry_id=$3 WHERE company_id=$1 AND id=$2",[f.f.companyA,invoice,journal]);
 const approvalId=await f.approve(f.ref('supplier_invoice.cancel',invoice)),before=await f.state();
 expect((await f.cancel(invoice,approvalId)).status).toBe('cancelled');const after=await f.state();
 expect(after.gl_journal_entries).toEqual(before.gl_journal_entries);expect(after.gl_journal_lines).toEqual(before.gl_journal_lines);
 expect((await f.pool.query('SELECT amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[f.f.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[f.f.companyA,journal])).rows).toHaveLength(1);
});
it('independently voids still-processed legacy cash with an already reversed real journal and exactly un-applies its invoice',async()=>{
 const invoice=await f.invoice(),payment=await f.payment(invoice),journal=await reversedManual('payment');
 await f.pool.query("UPDATE supplier_invoices SET status='paid',amount_paid=115 WHERE company_id=$1 AND id=$2",[f.f.companyA,invoice]);
 await f.pool.query("UPDATE supplier_payments SET status='processed',gl_journal_entry_id=$3 WHERE company_id=$1 AND id=$2",[f.f.companyA,payment,journal]);
 const approvalId=await f.approve(f.ref('supplier_payment.void',payment)),before=await f.state();
 expect((await f.voidPayment(payment,approvalId)).status).toBe('cancelled');const after=await f.state();
 expect(after.gl_journal_entries).toEqual(before.gl_journal_entries);expect(after.gl_journal_lines).toEqual(before.gl_journal_lines);
 expect((await f.pool.query('SELECT amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[f.f.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await f.pool.query('SELECT a.amount_allocated::text FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2',[f.f.companyA,payment])).rows).toEqual([{amount_allocated:'115.00'}]);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[f.f.companyA,journal])).rows).toHaveLength(1);
});
