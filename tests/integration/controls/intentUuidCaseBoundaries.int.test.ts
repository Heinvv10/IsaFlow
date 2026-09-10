import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,bank,customer,fixture,pool,postedCash} from './cashApplicationFixture';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {preparePayrollCompensation,executePayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationControl';
async function approved(ref:OperationRef){const approval=await actor(()=>requestOperationApproval(requireControlTx(),ref));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');return approval.id;}
async function oneEffect(id:string,operation:string){
 const rows=await pool.query('SELECT entity_id,result FROM control_operation_effects WHERE company_id=$1 AND lower(entity_id)=$2 AND operation=$3',[fixture.companyA,id,operation]);
 expect(rows.rows).toHaveLength(1);expect(rows.rows[0].entity_id).toBe(id);expect(rows.rows[0].result.intentId).toBe(id);
}
for(const uppercaseFirst of [true,false]){
 const spelling=(id:string)=>uppercaseFirst?id.toUpperCase():id;
 const retry=(id:string)=>uppercaseFirst?id:id.toUpperCase();
 it(`bank receipt first uppercase=${uppercaseFirst} has one exact cash journal and replay`,async()=>{
  const tx=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',123.45,'Synthetic UUID receipt','imported')",[tx,fixture.companyA,bank]);
  const p=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]})),approvalId=await approved(p.operation);
  const result=await actor(()=>executeBankAllocation(requireControlTx(),spelling(p.intentId),{approvalId}));
  expect(await actor(()=>executeBankAllocation(requireControlTx(),retry(p.intentId)))).toEqual(result);
  expect(await actor(()=>executeBankAllocation(requireControlTx(),p.intentId.toUpperCase(),{approvalId}))).toEqual(result);
  await oneEffect(p.intentId,'bank_allocation.post');
  expect((await pool.query('SELECT total_amount::text FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,result.paymentId])).rows).toEqual([{total_amount:'123.45'}]);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,tx])).rows).toHaveLength(1);
 });
 it(`bank reversal first uppercase=${uppercaseFirst} preserves one original and contra`,async()=>{
  const {posted}=await postedCash();
  const p=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:posted.intentId,reversalDate:'2026-09-11',reason:'Synthetic UUID reversal'})),approvalId=await approved(p.operation);
  const result=await actor(()=>executeBankAllocationReversal(requireControlTx(),spelling(p.intentId),{approvalId}));
  expect(await actor(()=>executeBankAllocationReversal(requireControlTx(),retry(p.intentId)))).toEqual(result);
  expect(await actor(()=>executeBankAllocationReversal(requireControlTx(),p.intentId.toUpperCase(),{approvalId}))).toEqual(result);
  await oneEffect(p.intentId,'bank_allocation.reverse');
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[fixture.companyA,posted.journalEntryId])).rows).toHaveLength(1);
  expect((await pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.bankTransactionId])).rows[0].status).toBe('imported');
 });
 it(`cash application first uppercase=${uppercaseFirst} allocates exact existing cash once`,async()=>{
  const {posted,invoice}=await postedCash();
  const p=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115'}]})),approvalId=await approved(p.operation);
  const before=(await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 ORDER BY id',[fixture.companyA])).rows;
  const result=await actor(()=>executeCashApplication(requireControlTx(),spelling(p.intentId),{approvalId}));
  expect(await actor(()=>executeCashApplication(requireControlTx(),retry(p.intentId)))).toEqual(result);
  expect(await actor(()=>executeCashApplication(requireControlTx(),p.intentId.toUpperCase(),{approvalId}))).toEqual(result);
  await oneEffect(p.intentId,'cash_application.apply');
  expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows).toEqual([{amount_paid:'115.00'}]);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 ORDER BY id',[fixture.companyA])).rows).toEqual(before);
 });
 it(`cash reversal first uppercase=${uppercaseFirst} retains one inverse and original cash`,async()=>{
  const {posted,invoice}=await postedCash();
  const p=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115'}]})),approvalId=await approved(p.operation);
  await actor(()=>executeCashApplication(requireControlTx(),p.intentId,{approvalId}));
  const r=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:p.intentId,reversalDate:'2026-09-11',reason:'Synthetic UUID cash inverse'})),inverseApproval=await approved(r.operation);
  const result=await actor(()=>executeCashApplicationReversal(requireControlTx(),spelling(r.intentId),{approvalId:inverseApproval}));
  expect(await actor(()=>executeCashApplicationReversal(requireControlTx(),retry(r.intentId)))).toEqual(result);
  expect(await actor(()=>executeCashApplicationReversal(requireControlTx(),r.intentId.toUpperCase(),{approvalId:inverseApproval}))).toEqual(result);
  await oneEffect(r.intentId,'cash_application.reverse');
  expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows).toEqual([{amount_paid:'0.00'}]);
  expect((await pool.query('SELECT a.amount_allocated::text,a.reversal_intent_id FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND a.application_intent_id=$2',[fixture.companyA,p.intentId])).rows).toEqual([{amount_allocated:'115.00',reversal_intent_id:r.intentId}]);
 });
 it(`compensation first uppercase=${uppercaseFirst} retains one exact assignment and replay`,async()=>{
  const employee=randomUUID(),component=randomUUID();
  await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Synthetic','UUID','2020-01-01','active')",[employee,fixture.companyA,employee.slice(0,12)]);
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Synthetic UUID salary','3601','earning')",[component,fixture.companyA]);
  const p=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'123.45',effectiveFrom:'2027-01-01'}]})),approvalId=await approved(p.operation);
  const result=await actor(()=>executePayrollCompensation(requireControlTx(),spelling(p.intentId),{approvalId}));
  expect(await actor(()=>executePayrollCompensation(requireControlTx(),retry(p.intentId)))).toEqual(result);
  expect(await actor(()=>executePayrollCompensation(requireControlTx(),p.intentId.toUpperCase(),{approvalId}))).toEqual(result);
  await oneEffect(p.intentId,'payroll_compensation.change');
  expect((await pool.query('SELECT a.amount::text FROM payroll_employee_components a JOIN payroll_employees e ON e.id=a.employee_id WHERE e.company_id=$1 AND e.id=$2',[fixture.companyA,employee])).rows).toEqual([{amount:'123.45'}]);
 });
}
