import Decimal from 'decimal.js';
import type {ControlTx,OperationRef} from '../controls/contracts';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {recordCashApplicationChild} from './cashApplicationEffect';
import {assertCashApplicationReversible} from './cashApplicationReversalSources';
import {loadCashApplicationReversal} from './cashApplicationReversalMaterial';
import {cashApplicationTotal} from './cashApplicationPlan';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
export async function executeCashApplicationReversalEffect(ctx:ControlTx,ref:OperationRef,permit:ControlledEffectPermit){
 assertControlledEffectPermit(ctx,permit,ref);
 if(ref.entityType!=='cash_application_reversal_intent'||String(ref.operation)!=='cash_application.reverse')throw new Error('Cash reversal parent required');
 const state=await loadCashApplicationReversal(ctx,ref.entityId),original=await assertCashApplicationReversible(ctx,String(state.intent.original_intent_id));
 if(state.effect||state.periods.length!==1||state.periods[0]!.status!=='open'||state.vatLocks.length)throw new Error('Open unexecuted cash reversal required');
 const ledger=original.sources.ledger;
 if(ledger.lockdown_enabled===true&&(!ledger.lockdown_date||permit.accountingDate<=String(ledger.lockdown_date)))throw new Error('Cash reversal date is locked');
 const company=ctx.principal.companyId,kind=original.plan.kind;
 for(const before of original.rows){
  const rows=kind==='customer'?await ctx.sql`UPDATE customer_payment_allocations a SET reversed_at=clock_timestamp(),reversal_intent_id=${ref.entityId}::uuid
   FROM customer_payments p WHERE p.id=a.payment_id AND p.company_id=${company}::uuid AND a.id=${before.id}::uuid AND a.application_intent_id=${original.intent.id}::uuid AND a.reversed_at IS NULL RETURNING a.*`
   :await ctx.sql`UPDATE payment_allocations a SET reversed_at=clock_timestamp(),reversal_intent_id=${ref.entityId}::uuid
   FROM supplier_payments p WHERE p.id=a.payment_id AND p.company_id=${company}::uuid AND a.id=${before.id}::uuid AND a.application_intent_id=${original.intent.id}::uuid AND a.reversed_at IS NULL RETURNING a.*`;
  const after=(rows as Row[])[0];if(!after)throw new Error('Cash application row reversal raced');
  await recordCashApplicationChild(ctx,permit,kind==='customer'?'customer_payment_allocation':'supplier_payment_allocation',before,after,'cash_application.line_reversed');
 }
 for(const {invoice,allocation} of original.sources.invoices){
  const rows=kind==='customer'?await ctx.sql`UPDATE customer_invoices SET amount_paid=amount_paid-${allocation.amount}::numeric,
   updated_at=clock_timestamp(),paid_at=CASE WHEN amount_paid-${allocation.amount}::numeric=total_amount THEN COALESCE(paid_at,clock_timestamp()) ELSE NULL END,
   status=CASE WHEN amount_paid-${allocation.amount}::numeric=0 THEN 'approved' WHEN amount_paid-${allocation.amount}::numeric=total_amount THEN 'paid' ELSE 'partially_paid' END
   WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid AND amount_paid>=${allocation.amount}::numeric RETURNING *`
   :await ctx.sql`UPDATE supplier_invoices SET amount_paid=amount_paid-${allocation.amount}::numeric,
   updated_at=clock_timestamp(),paid_at=CASE WHEN amount_paid-${allocation.amount}::numeric=total_amount THEN COALESCE(paid_at,clock_timestamp()) ELSE NULL END,
   status=CASE WHEN amount_paid-${allocation.amount}::numeric=0 THEN 'approved' WHEN amount_paid-${allocation.amount}::numeric=total_amount THEN 'paid' ELSE 'partially_paid' END,
   payment_matched=(amount_paid-${allocation.amount}::numeric=total_amount),payment_matched_at=CASE WHEN amount_paid-${allocation.amount}::numeric=total_amount THEN clock_timestamp() ELSE NULL END
   WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid AND amount_paid>=${allocation.amount}::numeric RETURNING *`;
  const after=(rows as Row[])[0];if(!after)throw new Error('Cash inverse exceeds invoice paid balance');
  await recordCashApplicationChild(ctx,permit,kind==='customer'?'customer_invoice':'supplier_invoice',invoice,after,'cash_application.unapplied');
 }
 const remaining=original.sources.allocations.filter(a=>a.reversed_at==null&&a.application_intent_id!==original.intent.id).reduce((sum,a)=>sum.add(String(a.amount_allocated)),new D(0));
 const status=remaining.eq(String(original.sources.payment.total_amount))?'reconciled':kind==='customer'?'confirmed':'processed';
 const rows=kind==='customer'?await ctx.sql`UPDATE customer_payments SET status=${status},updated_at=clock_timestamp() WHERE company_id=${company}::uuid AND id=${original.plan.paymentId}::uuid RETURNING *`
  :await ctx.sql`UPDATE supplier_payments SET status=${status},updated_at=clock_timestamp() WHERE company_id=${company}::uuid AND id=${original.plan.paymentId}::uuid RETURNING *`;
 const after=(rows as Row[])[0];if(!after)throw new Error('Cash reversal payment disappeared');
 await recordCashApplicationChild(ctx,permit,kind==='customer'?'customer_payment':'supplier_payment',original.sources.payment,after,'cash_application.payment_unapplied');
 const observed=await loadCashApplicationReversal(ctx,ref.entityId,permit);
 return{intentId:ref.entityId,originalIntentId:String(original.intent.id),paymentId:original.plan.paymentId,amount:cashApplicationTotal(original.plan),currency:'ZAR',allocationIds:original.rows.map(a=>String(a.id)),afterFingerprint:observed.fingerprint};
}
