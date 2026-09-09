import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {actor,fixture,pool,postedCash} from './cashApplicationFixture';
import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {getCustomerPayments,getCustomerPaymentById} from '@/modules/accounting/services/ar/customerPaymentService';
import {getSupplierPayments,getSupplierPaymentById} from '@/modules/accounting/services/ap/supplierPaymentService';
for(const bothCompanies of [false,true])for(const kind of ['customer','supplier'] as const)it(`does not disclose a foreign ${kind} name with ${bothCompanies?'dual':'single'} company membership`,async()=>{
 const party=randomUUID(),payment=randomUUID(),secret=`Foreign synthetic ${kind} ${party}`;
 if(bothCompanies)await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[fixture.companyB,fixture.u1.id]);
 try{
 if(kind==='customer'){
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[party,fixture.companyB,secret]);
  await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',115,$4)",[payment,fixture.companyA,party,fixture.u1.id]);
  const list=await actor(()=>getCustomerPayments(fixture.companyA));
  const detail=await actor(()=>getCustomerPaymentById(fixture.companyA,payment));
  expect(JSON.stringify({list,detail})).not.toContain(secret);
 }else{
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)',[party,fixture.companyB,secret]);
  await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',115,$4)",[payment,fixture.companyA,party,fixture.u1.id]);
  const list=await actor(()=>getSupplierPayments(fixture.companyA));
  const detail=await actor(()=>getSupplierPaymentById(fixture.companyA,payment));
  expect(JSON.stringify({list,detail})).not.toContain(secret);
 }
 }finally{if(bothCompanies)await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyB,fixture.u1.id]);}
});

async function approvedApplication(){
 const {invoice,posted}=await postedCash();
 const prepared=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 return{invoice,posted,prepared,approval};
}
it('invalidates a cash approval after its target source changes',async()=>{
 const {invoice,prepared,approval}=await approvedApplication();
 await pool.query("UPDATE customer_invoices SET invoice_number=invoice_number||'-changed' WHERE company_id=$1 AND id=$2",[fixture.companyA,invoice]);
 await expect(actor(()=>executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id}))).rejects.toThrow(/changed|stale/i);
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
});
for(const executed of [false,true])it(`rechecks original approver authority ${executed?'on supplied and omitted approval retries':'before first cash execution'}`,async()=>{
 const {invoice,prepared,approval}=await approvedApplication();
 if(executed)await actor(()=>executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 const previous=(await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u2.id])).rows[0].role;
 await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
 try{
  await expect(actor(()=>executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id}))).rejects.toThrow(/approver|permission|role|authority/i);
  if(executed)await expect(actor(()=>executeCashApplication(requireControlTx(),prepared.intentId))).rejects.toThrow(/approver|permission|role|authority/i);
  expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe(executed?'115.00':'0.00');
 }finally{await pool.query('UPDATE company_users SET role=$3 WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u2.id,previous]);}
});
it('rolls back financial effects and committed child history with the surrounding transaction',async()=>{
 const {invoice,prepared,approval}=await approvedApplication();
 await expect(actor(async()=>{await executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id});throw new Error('Synthetic outer rollback');})).rejects.toThrow('Synthetic outer rollback');
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await pool.query('SELECT id FROM customer_payment_allocations WHERE application_intent_id=$1',[prepared.intentId])).rows).toHaveLength(0);
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_type='cash_application_intent' AND entity_id=$2",[fixture.companyA,prepared.intentId])).rows).toHaveLength(0);
 expect((await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_type='customer_invoice' AND entity_id=$2 AND action='cash_application.applied'",[fixture.companyA,invoice])).rows).toHaveLength(0);
 expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,approval.id])).rows[0].status).toBe('approved');
});

