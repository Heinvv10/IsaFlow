import Decimal from 'decimal.js';
import {z} from 'zod';
import {requireControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {loadCashApplicationIntent} from './cashApplicationMaterial';
import {executeCashApplication} from './cashApplicationControl';
import {cashApplicationMoney} from './cashApplicationPlan';
const D=Decimal.clone({precision:80});
export interface CashApplicationApprovalOptions {intentId?:string;approvalId?:string}
const optionsSchema=z.object({intentId:z.string().uuid(),approvalId:z.string().uuid().optional()}).strict();
const previewSchema=z.object({paymentId:z.string().uuid(),lines:z.array(z.object({invoiceId:z.string().uuid(),amount:z.number().finite()})).min(1).max(100)});
const compareIds=(a:{invoiceId:string},b:{invoiceId:string})=>a.invoiceId<b.invoiceId?-1:a.invoiceId>b.invoiceId?1:0;
/** Legacy numeric previews are not mutation authority; the stored exact plan is. */
export async function applyLegacyCashPlan(companyId:string,userId:string,kind:'customer'|'supplier',plan:{paymentId:string;lines:readonly {invoiceId:string;amount:number}[]},options?:CashApplicationApprovalOptions){
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Cash application actor mismatch');
 if(!options)throw new Error('Prepared cash application intent and independent approval required');
 // Canonical descriptor validation precedes parsing or property access; snapshots sever caller references.
 const captured=optionsSchema.parse(JSON.parse(canonicalJson(options)));
 const preview=previewSchema.parse(JSON.parse(canonicalJson(plan)));
 const requested=preview.lines.map(line=>{
  if(!Number.isFinite(line.amount)||new D(String(line.amount)).mul(100).gt(Number.MAX_SAFE_INTEGER))throw new Error('Legacy numeric cash amount requires exact decimal interface');
  return{invoiceId:line.invoiceId.toLowerCase(),amount:cashApplicationMoney(String(line.amount))};
 }).sort(compareIds);
 const material=await loadCashApplicationIntent(ctx,captured.intentId);
 const frozen=[...material.plan.applications].sort(compareIds);
 if(material.plan.kind!==kind||material.plan.paymentId!==preview.paymentId.toLowerCase()||canonicalJson(requested)!==canonicalJson(frozen))throw new Error('Legacy cash preview does not match immutable intent');
 return executeCashApplication(ctx,captured.intentId,{approvalId:captured.approvalId});
}
