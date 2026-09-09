import Decimal from 'decimal.js';
import {requireControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {loadCashApplicationIntent} from './cashApplicationMaterial';
import {executeCashApplication} from './cashApplicationControl';
import {cashApplicationMoney} from './cashApplicationPlan';
const D=Decimal.clone({precision:80});
export interface CashApplicationApprovalOptions {intentId?:string;approvalId?:string}
/** Legacy numeric previews are not mutation authority; the stored exact plan is. */
export async function applyLegacyCashPlan(companyId:string,userId:string,kind:'customer'|'supplier',plan:{paymentId:string;lines:readonly {invoiceId:string;amount:number}[]},options?:CashApplicationApprovalOptions){
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Cash application actor mismatch');
 if(!options?.intentId)throw new Error('Prepared cash application intent and independent approval required');
 const material=await loadCashApplicationIntent(ctx,options.intentId);
 const requested=plan.lines.map(line=>{
  if(!Number.isFinite(line.amount)||new D(String(line.amount)).mul(100).gt(Number.MAX_SAFE_INTEGER))throw new Error('Legacy numeric cash amount requires exact decimal interface');
  return{invoiceId:line.invoiceId.toLowerCase(),amount:cashApplicationMoney(String(line.amount))};
 }).sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId));
 const frozen=[...material.plan.applications].sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId));
 if(material.plan.kind!==kind||material.plan.paymentId!==plan.paymentId.toLowerCase()||canonicalJson(requested)!==canonicalJson(frozen))throw new Error('Legacy cash preview does not match immutable intent');
 return executeCashApplication(ctx,options.intentId,{approvalId:options.approvalId});
}
