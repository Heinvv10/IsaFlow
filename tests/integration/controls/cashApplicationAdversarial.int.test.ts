import {applyLegacyCashPlan} from '@/modules/accounting/services/shared/cashApplicationLegacyAdapter';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
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

it('refuses another tenant attempting to execute an owned cash intent',async()=>{
 const {prepared,approval,invoice}=await approvedApplication();
 await expect(actor(()=>executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id}),'u3')).rejects.toThrow(/owned|not found|permission/i);
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
});
it('refuses accounting dates before original cash and invoice dates',async()=>{
 const {invoice,posted}=await postedCash();
 await expect(actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-08',applications:[{invoiceId:invoice,amount:'115.00'}]}))).rejects.toThrow(/predate/i);
 expect((await pool.query('SELECT id FROM control_cash_application_intents WHERE company_id=$1 AND payment_id=$2',[fixture.companyA,posted.paymentId])).rows).toHaveLength(0);
});
it('supports approved reapplication after inverse without deleting original history',async()=>{
 const {prepared,approval,invoice,posted}=await approvedApplication();
 await actor(()=>executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 const inverse=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-09-11',reason:'Synthetic reapplication'}));
 const inverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),inverse.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),inverseApproval.id,'approved'),'u2');
 await actor(()=>executeCashApplicationReversal(requireControlTx(),inverse.intentId,{approvalId:inverseApproval.id}));
 const next=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-12',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const nextApproval=await actor(()=>requestOperationApproval(requireControlTx(),next.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),nextApproval.id,'approved'),'u2');
 await actor(()=>executeCashApplication(requireControlTx(),next.intentId,{approvalId:nextApproval.id}));
 expect((await pool.query('SELECT count(*)::int AS count,sum(amount_allocated)::text AS all_amount,sum(amount_allocated) FILTER(WHERE reversed_at IS NULL)::text AS active_amount FROM customer_payment_allocations WHERE payment_id=$1',[posted.paymentId])).rows[0]).toEqual({count:2,all_amount:'230.00',active_amount:'115.00'});
});
it('does not overapply cash when two distinct approved plans execute concurrently',async()=>{
 const {invoice,posted}=await postedCash(),plans=[];
 for(let n=0;n<2;n++){
  const prepared=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'60.00'}]}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');plans.push({prepared,approval});
 }
 const results=await Promise.allSettled(plans.map(({prepared,approval})=>actor(()=>executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id}))));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('60.00');
});

it('rejects mutable accessor authority rather than executing a second approved cash intent',async()=>{
 const first=await approvedApplication(),second=await approvedApplication();let reads=0;
 const options={get intentId(){return ++reads<3?first.prepared.intentId:second.prepared.intentId;},get approvalId(){return second.approval.id;}};
 await expect(actor(()=>applyLegacyCashPlan(fixture.companyA,fixture.u1.id,'customer',{paymentId:first.posted.paymentId!,lines:[{invoiceId:first.invoice,amount:115}]},options))).rejects.toThrow(/property|descriptor/i);
 expect(reads).toBe(0);
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=ANY($2::uuid[])',[fixture.companyA,[first.invoice,second.invoice]])).rows.map(row=>row.amount_paid)).toEqual(['0.00','0.00']);
});
