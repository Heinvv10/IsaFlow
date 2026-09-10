// Baseline-only seed. intentReceiptLegacyHarness.ts runs an identical copy of this file inside an
// isolated worktree pinned to an older commit, so every receipt is written by genuine legacy source.
// It records each outcome (success or the baseline's own refusal) and never edits a committed row.
import {it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {actor,bank,customer,fixture,pool,postedCash} from './cashApplicationFixture';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {preparePayrollCompensation,executePayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationControl';
type Outcome={intentId:string;approvalId:string;ok:true;result:unknown}|{intentId:string;approvalId:string;ok:false;error:string};
async function approved(ref:OperationRef){const approval=await actor(()=>requestOperationApproval(requireControlTx(),ref));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');return approval.id;}
// A legacy caller spells the intent in uppercase for both its approval request and its execution.
async function upperFirst(intentId:string,operation:OperationRef,execute:(id:string,approvalId:string)=>Promise<unknown>):Promise<Outcome>{
 const approvalId=await approved({...operation,entityId:intentId.toUpperCase()});
 try{return{intentId,approvalId,ok:true,result:await actor(()=>execute(intentId.toUpperCase(),approvalId))};}
 catch(error){return{intentId,approvalId,ok:false,error:error instanceof Error?error.message:String(error)};}
}
async function bankReceipt(){
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',123.45,'Synthetic legacy UUID receipt','imported')",[tx,fixture.companyA,bank]);
 const p=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 return upperFirst(p.intentId,p.operation,(id,approvalId)=>executeBankAllocation(requireControlTx(),id,{approvalId}));
}
async function bankReversal(){
 const {posted}=await postedCash();
 const p=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:posted.intentId,reversalDate:'2026-09-11',reason:'Synthetic legacy UUID reversal'}));
 return upperFirst(p.intentId,p.operation,(id,approvalId)=>executeBankAllocationReversal(requireControlTx(),id,{approvalId}));
}
async function cashApplication(){
 const {posted,invoice}=await postedCash();
 const p=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115'}]}));
 return upperFirst(p.intentId,p.operation,(id,approvalId)=>executeCashApplication(requireControlTx(),id,{approvalId}));
}
async function cashReversal(){
 const {posted,invoice}=await postedCash();
 const p=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115'}]}));
 const approvalId=await approved(p.operation);await actor(()=>executeCashApplication(requireControlTx(),p.intentId,{approvalId}));
 const r=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:p.intentId,reversalDate:'2026-09-11',reason:'Synthetic legacy UUID cash inverse'}));
 return upperFirst(r.intentId,r.operation,(id,approval)=>executeCashApplicationReversal(requireControlTx(),id,{approvalId:approval}));
}
async function compensation(){
 const employee=randomUUID(),component=randomUUID();
 await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Synthetic','Legacy','2020-01-01','active')",[employee,fixture.companyA,employee.slice(0,12)]);
 await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3601','earning')",[component,fixture.companyA,`Synthetic legacy salary ${component}`]);
 const p=await actor(()=>preparePayrollCompensation(requireControlTx(),{version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'123.45',effectiveFrom:'2027-01-01'}]}));
 return upperFirst(p.intentId,p.operation,(id,approvalId)=>executePayrollCompensation(requireControlTx(),id,{approvalId}));
}
it('seeds uppercase-first receipts with the baseline source',async()=>{
 const output=process.env.ISAFLOW_INTENT_SEED_OUT;if(!output)throw new Error('ISAFLOW_INTENT_SEED_OUT is required');
 const ops={bank:await bankReceipt(),bankOriginal:await bankReceipt(),bankReversal:await bankReversal(),cash:await cashApplication(),cashReversal:await cashReversal(),compensation:await compensation()};
 const identity=(user:{id:string;companyId:string})=>({id:user.id,companyId:user.companyId});
 await writeFile(output,JSON.stringify({fixture:{companyA:fixture.companyA,u1:identity(fixture.u1),u2:identity(fixture.u2)},
  keys:{encryption:process.env.ENCRYPTION_KEY,fingerprint:process.env.CONTROL_FINGERPRINT_KEY},ops}),{mode:0o600});
},300000);
