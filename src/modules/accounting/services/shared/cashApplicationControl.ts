import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import {parseCashApplicationPlan,cashApplicationTotal} from './cashApplicationPlan';
import {loadCashApplicationSources} from './cashApplicationSources';
const D=Decimal.clone({precision:80});
export async function prepareCashApplication(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 const plan=parseCashApplicationPlan(input);
 return withSavepoint('cash_application_prepare',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const sources=await loadCashApplicationSources(ctx,plan),amount=cashApplicationTotal(plan);
  if(sources.ledger.lockdown_enabled===true&&(!sources.ledger.lockdown_date||plan.accountingDate<=String(sources.ledger.lockdown_date)))throw new Error('Cash application date is within company lockdown');
  if(sources.periods.length!==1||sources.periods[0]!.status!=='open'||sources.vatLocks.length)throw new Error('Open unlocked cash application period required');
  const active=sources.allocations.filter(a=>a.reversed_at==null);
  const allocated=active.reduce((sum,a)=>sum.add(String(a.amount_allocated)),new D(0));
  if(allocated.add(amount).gt(String(sources.payment.total_amount)))throw new Error('Cash application exceeds unapplied payment');
  for(const {invoice,allocation} of sources.invoices)if(new D(String(invoice.amount_paid)).add(allocation.amount).gt(String(invoice.total_amount)))throw new Error('Cash application exceeds invoice outstanding');
  const id=randomUUID();
  await ctx.sql`INSERT INTO control_cash_application_intents(company_id,id,requester_person_id,payment_id,kind,accounting_date,amount,currency,payload,source_fingerprint)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${plan.paymentId}::uuid,${plan.kind},${plan.accountingDate}::date,${amount}::numeric,'ZAR',${JSON.stringify(plan)}::jsonb,${sources.fingerprint})`;
  await recordCommittedChange(ctx,{entityType:'cash_application_intent',entityId:id,previousVersion:null,newVersion:1,action:'cash_application.prepared',accountingDate:plan.accountingDate,
   before:null,after:{paymentId:plan.paymentId,kind:plan.kind,amount,currency:'ZAR'},bindingHash:null,protectedEvidenceRef:null});
  return{intentId:id,operation:{entityType:'cash_application_intent',entityId:id,operation:'cash_application.apply' as const}};
 });
}
