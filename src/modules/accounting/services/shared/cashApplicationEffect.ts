import Decimal from 'decimal.js';
import type {ControlTx,OperationRef} from '../controls/contracts';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {recordCommittedChange} from '../controls/changeEventService';
import {readControlEntityVersion} from '../controls/operationVersions';
import {loadCashApplicationIntent} from './cashApplicationMaterial';
import {loadCashApplicationSources} from './cashApplicationSources';
import {cashApplicationTotal} from './cashApplicationPlan';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
export async function recordCashApplicationChild(ctx:ControlTx,permit:ControlledEffectPermit,entityType:string,before:Row|null,after:Row,action:string){
 assertControlledEffectPermit(ctx,permit,{entityType:permit.entityType,entityId:permit.entityId,operation:permit.operation});
 if(!['cash_application.apply','cash_application.reverse'].includes(String(permit.operation)))throw new Error('Cash application history parent required');
 const entityId=String(after.id),previous=await readControlEntityVersion(ctx,{entityType,entityId});
 await recordCommittedChange(ctx,{entityType,entityId,previousVersion:previous?.version??null,newVersion:(previous?.version??0)+1,action,
  accountingDate:permit.accountingDate,before,after,bindingHash:null,protectedEvidenceRef:null,operationId:permit.operationId});
}
export async function executeCashApplicationEffect(ctx:ControlTx,ref:OperationRef,permit:ControlledEffectPermit){
 assertControlledEffectPermit(ctx,permit,ref);
 if(ref.entityType!=='cash_application_intent'||String(ref.operation)!=='cash_application.apply')throw new Error('Cash application parent required');
 const {intent,plan,sources,effect}=await loadCashApplicationIntent(ctx,ref.entityId);
 if(effect)throw new Error('Cash application already executed');
 const amount=cashApplicationTotal(plan),active=sources.allocations.filter(a=>a.reversed_at==null),applied=active.reduce((sum,a)=>sum.add(String(a.amount_allocated)),new D(0));
 if(sources.periods.length!==1||sources.periods[0]!.status!=='open'||sources.vatLocks.length)throw new Error('Open unlocked cash application period required');
 if(sources.ledger.lockdown_enabled===true&&(!sources.ledger.lockdown_date||permit.accountingDate<=String(sources.ledger.lockdown_date)))throw new Error('Cash application date is locked');
 if(applied.add(amount).gt(String(sources.payment.total_amount)))throw new Error('Cash application exceeds unapplied payment');
 const company=ctx.principal.companyId,allocationIds:string[]=[];
 for(const {allocation,invoice} of sources.invoices){
  if(new D(String(invoice.amount_paid)).add(allocation.amount).gt(String(invoice.total_amount)))throw new Error('Cash application exceeds invoice outstanding');
  const rows=plan.kind==='customer'?await ctx.sql`INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated,application_intent_id)
   VALUES(${plan.paymentId}::uuid,${allocation.invoiceId}::uuid,${allocation.amount}::numeric,${intent.id}::uuid) RETURNING *`
   :await ctx.sql`INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated,application_intent_id)
   VALUES(${plan.paymentId}::uuid,${allocation.invoiceId}::uuid,${allocation.amount}::numeric,${intent.id}::uuid) RETURNING *`;
  const row=(rows as Row[])[0];if(!row)throw new Error('Cash allocation row disappeared');allocationIds.push(String(row.id));
  await recordCashApplicationChild(ctx,permit,plan.kind==='customer'?'customer_payment_allocation':'supplier_payment_allocation',null,row,'cash_application.line_created');
  const updates=plan.kind==='customer'?await ctx.sql`UPDATE customer_invoices SET amount_paid=amount_paid+${allocation.amount}::numeric,
   updated_at=clock_timestamp(),paid_at=CASE WHEN amount_paid+${allocation.amount}::numeric=total_amount THEN COALESCE(paid_at,clock_timestamp()) ELSE NULL END,
   status=CASE WHEN amount_paid+${allocation.amount}::numeric=total_amount THEN 'paid' ELSE 'partially_paid' END
   WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid AND amount_paid+${allocation.amount}::numeric<=total_amount RETURNING *`
   :await ctx.sql`UPDATE supplier_invoices SET amount_paid=amount_paid+${allocation.amount}::numeric,
   updated_at=clock_timestamp(),paid_at=CASE WHEN amount_paid+${allocation.amount}::numeric=total_amount THEN COALESCE(paid_at,clock_timestamp()) ELSE NULL END,
   status=CASE WHEN amount_paid+${allocation.amount}::numeric=total_amount THEN 'paid' ELSE 'partially_paid' END,
   payment_matched=(amount_paid+${allocation.amount}::numeric=total_amount),payment_matched_at=CASE WHEN amount_paid+${allocation.amount}::numeric=total_amount THEN clock_timestamp() ELSE NULL END
   WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid AND amount_paid+${allocation.amount}::numeric<=total_amount RETURNING *`;
  const after=(updates as Row[])[0];if(!after)throw new Error('Cash application target changed');
  await recordCashApplicationChild(ctx,permit,plan.kind==='customer'?'customer_invoice':'supplier_invoice',invoice,after,'cash_application.applied');
 }
 const status=applied.add(amount).eq(String(sources.payment.total_amount))?'reconciled':plan.kind==='customer'?'confirmed':'processed';
 const updates=plan.kind==='customer'?await ctx.sql`UPDATE customer_payments SET status=${status},updated_at=clock_timestamp() WHERE company_id=${company}::uuid AND id=${plan.paymentId}::uuid RETURNING *`
  :await ctx.sql`UPDATE supplier_payments SET status=${status},updated_at=clock_timestamp() WHERE company_id=${company}::uuid AND id=${plan.paymentId}::uuid RETURNING *`;
 const after=(updates as Row[])[0];if(!after)throw new Error('Cash application payment disappeared');
 await recordCashApplicationChild(ctx,permit,plan.kind==='customer'?'customer_payment':'supplier_payment',sources.payment,after,'cash_application.payment_updated');
 const observed=await loadCashApplicationSources(ctx,plan);
 return{intentId:intent.id,paymentId:plan.paymentId,allocationIds,amount,currency:'ZAR',afterFingerprint:observed.fingerprint};
}
