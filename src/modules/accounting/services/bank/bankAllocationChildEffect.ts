import {recomputeInvoiceStatus} from '../ar/invoiceStatusRecompute';
import {assertAllocationOutstanding,isBankAllocationRefund} from './bankAllocationPlan';
import type {ControlTx} from '../controls/contracts';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {recordCommittedChange} from '../controls/changeEventService';
import {readControlEntityVersion} from '../controls/operationVersions';
import type {BankAllocationPlan} from './bankAllocationPlan';
type Row=Record<string,unknown>;
export async function recordBankAllocationChild(ctx:ControlTx,permit:ControlledEffectPermit,entityType:string,before:Row|null,after:Row,action:string){
 const entityId=String(after.id),prior=await readControlEntityVersion(ctx,{entityType,entityId});
 await recordCommittedChange(ctx,{entityType,entityId,previousVersion:prior?.version??null,newVersion:(prior?.version??0)+1,
  action,accountingDate:permit.accountingDate,before,after,bindingHash:null,protectedEvidenceRef:null,operationId:permit.operationId});
}
export async function applyBankAllocationChildren(ctx:ControlTx,permit:ControlledEffectPermit,plan:BankAllocationPlan,journalId:string,amount:string){
 assertControlledEffectPermit(ctx,permit,{entityType:'bank_allocation_intent',entityId:permit.entityId,operation:'bank_allocation.post'});
 if(!('applications' in plan))return null;
 const company=ctx.principal.companyId;
 const [bank]=await ctx.sql`SELECT bank_account_id,amount::text FROM bank_transactions WHERE company_id=${company}::uuid AND id=${plan.bankTransactionId}::uuid` as Row[];
 if(!bank)throw new Error('Allocation bank disappeared');
 if(isBankAllocationRefund(plan.kind,String(bank.amount))){
  if(plan.applications.length)throw new Error('Refund applications must be empty');
  return null;
 }
 const payments=plan.kind==='customer'?await ctx.sql`INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,bank_account_id,status,gl_journal_entry_id,created_by,confirmed_by,confirmed_at,currency_code)
  VALUES(${company}::uuid,${plan.partyId}::uuid,${permit.accountingDate}::date,${amount}::numeric,'eft',${bank.bank_account_id}::uuid,'confirmed',${journalId}::uuid,${ctx.principal.personId}::uuid,${ctx.principal.personId}::uuid,clock_timestamp(),'ZAR') RETURNING *`
  :await ctx.sql`INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,status,gl_journal_entry_id,created_by,processed_at)
  VALUES(${company}::uuid,${plan.partyId}::uuid,${permit.accountingDate}::date,${amount}::numeric,'eft',${bank.bank_account_id}::uuid,'processed',${journalId}::uuid,${ctx.principal.personId}::uuid,clock_timestamp()) RETURNING *`;
 const payment=(payments as Row[])[0];if(!payment)throw new Error('Allocation payment insert failed');
 for(const application of plan.applications){
  const rows=plan.kind==='customer'?await ctx.sql`SELECT * FROM customer_invoices WHERE company_id=${company}::uuid AND id=${application.invoiceId}::uuid FOR UPDATE`
   :await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${application.invoiceId}::uuid FOR UPDATE`;
  const before=(rows as Row[])[0];if(!before)throw new Error('Allocation invoice disappeared');assertAllocationOutstanding(String(before.total_amount),String(before.amount_paid),application.amount);
  if(plan.kind==='customer')await ctx.sql`INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES(${payment.id}::uuid,${application.invoiceId}::uuid,${application.amount}::numeric)`;
  else await ctx.sql`INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES(${payment.id}::uuid,${application.invoiceId}::uuid,${application.amount}::numeric)`;
  const updates=plan.kind==='customer'?await ctx.sql`UPDATE customer_invoices SET amount_paid=amount_paid+${application.amount}::numeric
   WHERE company_id=${company}::uuid AND id=${application.invoiceId}::uuid RETURNING id`
   :await ctx.sql`UPDATE supplier_invoices SET amount_paid=amount_paid+${application.amount}::numeric
   WHERE company_id=${company}::uuid AND id=${application.invoiceId}::uuid RETURNING id`;
  if(!(updates as Row[])[0])throw new Error('Allocation invoice disappeared');
  await recomputeInvoiceStatus(company,plan.kind,application.invoiceId);
  const settled=plan.kind==='customer'?await ctx.sql`SELECT * FROM customer_invoices WHERE company_id=${company}::uuid AND id=${application.invoiceId}::uuid`
   :await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${application.invoiceId}::uuid`;
  const after=(settled as Row[])[0];if(!after)throw new Error('Allocation invoice disappeared');
  await recordBankAllocationChild(ctx,permit,plan.kind==='customer'?'customer_invoice':'supplier_invoice',before,after,'bank_allocation.applied');
 }
 await recordBankAllocationChild(ctx,permit,plan.kind==='customer'?'customer_payment':'supplier_payment',null,payment,'bank_allocation.payment_created');
 return String(payment.id);
}
