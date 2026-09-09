import type {ControlTx,OperationRef} from './contracts';
import type {ApMaterial} from './apOperationMaterializer';
import {canonicalJson,canonicalMoney} from './canonical';
import {deriveArRecurringMoney} from './arRecurringExact';
import type {ArRow} from './arSourceMaterial';
import {materializeArOperation,observeArSource} from './arOperationMaterializer';
/** The prepared invoice is a durable source; schedule advancement is an execution guard, not an after-history read guard. */
export async function materializeArRecurringOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 const company=ctx.principal.companyId;
 const [intent]=await ctx.sql`SELECT * FROM control_recurring_invoice_runs WHERE company_id=${company}::uuid AND id=${ref.entityId}::uuid` as ArRow[];
 if(!intent)throw new Error('Recurring invoice run not found');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-ar:${company}`},0))`;
 const [template]=await ctx.sql`SELECT * FROM recurring_invoices WHERE company_id=${company}::uuid AND id=${String(intent.template_id)}::uuid FOR UPDATE` as ArRow[];
 if(!template)throw new Error('Recurring invoice template not found');
 const invoice=await materializeArOperation(ctx,{entityType:'customer_invoice',entityId:String(intent.invoice_id),operation:'customer_invoice.post'});
 const invoiceSource=invoice.observedSources.find(s=>s.entityType==='customer_invoice'&&s.entityId===String(intent.invoice_id))!;
 const header=(invoiceSource.facts as {header:ArRow}).header;
 if(header.owned_customer_id!==template.client_id||template.currency_code!==invoice.binding.currency)throw new Error('Recurring invoice source no longer matches');
 const derived=deriveArRecurringMoney(template,invoice.binding.currency!);
 const invoiceFacts=invoiceSource.facts as {header:ArRow;lines:ArRow[]};
 const normalize=(lines:ArRow[])=>lines.map(line=>canonicalJson({description:line.description,quantity:canonicalMoney(String(line.quantity)),unit_price:canonicalMoney(String(line.unit_price)),amount:canonicalMoney(String(line.amount))})).sort();
 if(derived.amount!==invoice.binding.amount||canonicalJson(normalize(derived.lines))!==canonicalJson(normalize(invoiceFacts.lines))||
  (header.project_id??null)!==(template.project_id??null))throw new Error('Recurring invoice source no longer matches');
 const facts={intent,template,invoice:invoiceSource.facts};
 const parent=await observeArSource(ctx,ref.entityType,ref.entityId,facts);
 const source=await observeArSource(ctx,'recurring_invoice',String(intent.template_id),template);
 const sources=[parent,source,...invoice.observedSources];
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Recurring invoice run version changed');
 return{supplierId:'',observedSources:sources,versionBasis:sources.every(s=>s.tracked)?'recorded_with_current_fingerprint':'untracked_current_observation',
 binding:{...invoice.binding,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,entityVersion:parent.version,
 sourceVersions:sources.map(({facts:_facts,tracked:_tracked,...s})=>s)}};
}
