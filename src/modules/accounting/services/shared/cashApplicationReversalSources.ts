import Decimal from 'decimal.js';
import {canonicalJson} from '../controls/canonical';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {loadIntentReceipt,sameIntentId} from '../controls/intentIdentity';
import {parseCashApplicationPlan,cashApplicationTotal} from './cashApplicationPlan';
import {loadCashApplicationSources} from './cashApplicationSources';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
/** Later authorized applications may change current balances; the exact original effect's rows remain the inverse authority. */
export async function loadOriginalCashApplication(ctx:ControlTx,id:string){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const [intent]=await ctx.sql`SELECT *,accounting_date::text,amount::text FROM control_cash_application_intents WHERE company_id=${company}::uuid AND id=${id}::uuid` as Row[];
 if(!intent)throw new Error('Original cash application intent required');
 const plan=parseCashApplicationPlan(intent.payload);
 if(intent.id!==id||intent.payment_id!==plan.paymentId||intent.kind!==plan.kind||intent.accounting_date!==plan.accountingDate||intent.currency!=='ZAR'||!new D(String(intent.amount)).eq(cashApplicationTotal(plan)))throw new Error('Original cash application intent changed');
 const effect=await loadIntentReceipt<{intentId:string;paymentId:string;amount:string;allocationIds:string[]}>(ctx,{entityType:'cash_application_intent',entityId:id,operation:'cash_application.apply'});
 if(!effect||!sameIntentId(effect.result.intentId,id)||effect.result.paymentId!==plan.paymentId||!Array.isArray(effect.result.allocationIds)
  ||new Set(effect.result.allocationIds).size!==plan.applications.length||!new D(effect.result.amount).eq(cashApplicationTotal(plan)))throw new Error('Original cash application effect required');
 const sources=await loadCashApplicationSources(ctx,plan),rows=sources.allocations.filter(a=>a.application_intent_id===id);
 const shape=(invoiceId:unknown,amount:unknown)=>canonicalJson({invoiceId,amount:new D(String(amount)).toFixed(2)});
 const expected=plan.applications.map(a=>shape(a.invoiceId,a.amount)).sort(),actual=rows.map(a=>shape(a.invoice_id,a.amount_allocated)).sort();
 if(rows.length!==effect.result.allocationIds.length||!rows.every(a=>effect.result.allocationIds.includes(String(a.id)))||canonicalJson(expected)!==canonicalJson(actual))throw new Error('Original cash application row lineage changed');
 return{intent,plan,effect,sources,rows};
}
export async function assertCashApplicationReversible(ctx:ControlTx,id:string){
 const original=await loadOriginalCashApplication(ctx,id);
 if(original.rows.some(row=>row.reversed_at!=null||row.reversal_intent_id!=null))throw new Error('Cash application already reversed');
 for(const {invoice,allocation} of original.sources.invoices)if(new D(String(invoice.amount_paid)).lt(allocation.amount))throw new Error('Cash inverse exceeds current paid balance');
 return original;
}
