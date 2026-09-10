import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,fixture,pool,postedCash} from './cashApplicationFixture';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {applyLegacyCashPlan} from '@/modules/accounting/services/shared/cashApplicationLegacyAdapter';
import {preparePayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationControl';
import {executeCompensationCaller} from '@/modules/accounting/services/controls/payrollCompensationLegacyAdapter';
import {effectRows,insertCaseVariantReceipt,ledgerRows,receiptsFor} from './intentReceiptRows';
async function approved(ref:OperationRef){const approval=await actor(()=>requestOperationApproval(requireControlTx(),ref));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');return approval.id;}
async function oneCanonicalEffect(id:string,operation:string){
 const rows=await receiptsFor(pool,fixture.companyA,id,operation);
 expect(rows).toHaveLength(1);expect(rows[0]!.entity_id).toBe(id);expect(rows[0]!.result.intentId).toBe(id);
}
async function cashIntent(){
 const {posted,invoice}=await postedCash();
 const p=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115'}]}));
 return{posted,invoice,p,approvalId:await approved(p.operation)};
}
for(const uppercaseFirst of [true,false]){
 const spelling=(id:string)=>uppercaseFirst?id.toUpperCase():id,retry=(id:string)=>uppercaseFirst?id:id.toUpperCase();
 it(`legacy cash adapter first uppercase=${uppercaseFirst} applies once and replays the other spelling`,async()=>{
  const {posted,invoice,p,approvalId}=await cashIntent();
  const plan={paymentId:posted.paymentId!,lines:[{invoiceId:invoice,amount:115}]};
  const apply=(intentId:string,approval?:string)=>actor(()=>applyLegacyCashPlan(fixture.companyA,fixture.u1.id,'customer',plan,approval?{intentId,approvalId:approval}:{intentId}));
  const result=await apply(spelling(p.intentId),approvalId);
  expect(await apply(retry(p.intentId))).toEqual(result);
  expect(await apply(retry(p.intentId),approvalId)).toEqual(result);
  await oneCanonicalEffect(p.intentId,'cash_application.apply');
  expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows).toEqual([{amount_paid:'115.00'}]);
 });
 it(`legacy compensation caller first uppercase=${uppercaseFirst} assigns once and replays the other spelling`,async()=>{
  const employee=randomUUID(),component=randomUUID();
  await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Synthetic','Caller','2020-01-01','active')",[employee,fixture.companyA,employee.slice(0,12)]);
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3601','earning')",[component,fixture.companyA,`Synthetic caller salary ${component}`]);
  const input={version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'123.45',effectiveFrom:'2027-01-01'}]};
  const p=await actor(()=>preparePayrollCompensation(requireControlTx(),input)),approvalId=await approved(p.operation);
  const call=(intentId:string,approval?:string)=>actor(()=>executeCompensationCaller(fixture.companyA,input,approval?{intentId,approvalId:approval}:{intentId},fixture.u1.id));
  const result=await call(spelling(p.intentId),approvalId);
  expect(await call(retry(p.intentId))).toEqual(result);
  expect(await call(retry(p.intentId),approvalId)).toEqual(result);
  await oneCanonicalEffect(p.intentId,'payroll_compensation.change');
  expect((await pool.query('SELECT a.amount::text FROM payroll_employee_components a JOIN payroll_employees e ON e.id=a.employee_id WHERE e.company_id=$1 AND e.id=$2',[fixture.companyA,employee])).rows).toEqual([{amount:'123.45'}]);
 });
}
it('cash reversal refuses a case-variant twin receipt without another effect or ledger change',async()=>{
 const {p,approvalId}=await cashIntent();
 await actor(()=>executeCashApplication(requireControlTx(),p.intentId,{approvalId}));
 const r=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:p.intentId,reversalDate:'2026-09-11',reason:'Synthetic twin inverse'}));
 const inverseApproval=await approved(r.operation);
 await actor(()=>executeCashApplicationReversal(requireControlTx(),r.intentId,{approvalId:inverseApproval}));
 const [receipt]=await receiptsFor(pool,fixture.companyA,r.intentId,'cash_application.reverse');
 await insertCaseVariantReceipt(pool,{id:fixture.u1.id,companyId:fixture.companyA},receipt!.id);
 const before={effects:await effectRows(pool,fixture.companyA),ledger:await ledgerRows(pool,fixture.companyA)};
 for(const id of [r.intentId,r.intentId.toUpperCase()])await expect(actor(()=>executeCashApplicationReversal(requireControlTx(),id))).rejects.toThrow('Ambiguous operation receipt');
 expect({effects:await effectRows(pool,fixture.companyA),ledger:await ledgerRows(pool,fixture.companyA)}).toEqual(before);
});
